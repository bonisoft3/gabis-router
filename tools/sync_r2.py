#!/usr/bin/env python3
"""Reproducible CLI tool to configure the Cloudflare R2 bucket and sync UK .rd5 + .pmtiles data."""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SEGMENTS_DIR = REPO_ROOT / "data" / "segments4"
MAP_TILES_DIR = REPO_ROOT / "web" / "map-tiles"
PMTILES_CLI = REPO_ROOT / "tools" / "pmtiles"

DEFAULT_BUCKET = "gbrouter"
DEFAULT_DOMAIN = "tiles.surita.dev"
DEFAULT_ZONE_ID = os.environ.get("CLOUDFLARE_ZONE_ID", "")
UK_SEGMENTS = ["E0_N50", "W5_N50", "W5_N55", "W5_N60", "W10_N50", "W10_N55", "W15_N50"]
BROUTER_SEGMENTS_URL = "https://brouter.de/brouter/segments4"

CORS_RULES = {
    "rules": [
        {
            "allowed": {
                "origins": [
                    "https://router.surita.dev",
                    "http://localhost:3000",
                    "https://localhost:3000",
                    "https://localhost",
                    "capacitor://localhost",
                ],
                "methods": ["GET", "HEAD"],
                "headers": ["Range", "If-None-Match", "Content-Type"],
            },
            "exposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"],
            "maxAgeSeconds": 86400,
        }
    ]
}

MULTIPART_WORKER_JS = """export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const key = url.searchParams.get("key");
    const action = url.searchParams.get("action");
    if (!key) return new Response("Missing key", { status: 400 });

    if (action === "create") {
      const contentType = url.searchParams.get("type") || "application/octet-stream";
      const mpu = await env.BUCKET.createMultipartUpload(key, {
        httpMetadata: { contentType },
      });
      return Response.json({ uploadId: mpu.uploadId, key: mpu.key });
    }
    if (action === "part") {
      const uploadId = url.searchParams.get("uploadId");
      const partNumber = Number(url.searchParams.get("partNumber"));
      const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);
      const part = await mpu.uploadPart(partNumber, req.body);
      return Response.json(part);
    }
    if (action === "complete") {
      const uploadId = url.searchParams.get("uploadId");
      const parts = await req.json();
      const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);
      const obj = await mpu.complete(parts);
      return Response.json({ key: obj.key, size: obj.size, etag: obj.httpEtag });
    }
    return new Response("Unknown action", { status: 400 });
  }
};
"""


def run(cmd, **kwargs):
    print(f"$ {' '.join(str(c) for c in cmd)}", flush=True)
    subprocess.run(cmd, check=True, **kwargs)


def parse_segment_bbox(segment_id: str):
    m = re.match(r"^([EW])(\d+)_([NS])(\d+)$", segment_id)
    if not m:
        raise ValueError(f"Invalid segment ID: {segment_id}")
    min_lon = -int(m.group(2)) if m.group(1) == "W" else int(m.group(2))
    min_lat = -int(m.group(4)) if m.group(3) == "S" else int(m.group(4))
    return min_lon, min_lat, min_lon + 5, min_lat + 5


def latest_protomaps_build_url() -> str:
    req = urllib.request.Request(
        "https://maps.protomaps.com/builds.json",
        headers={"User-Agent": "rsrouter-r2-sync"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        builds = json.load(resp)
    latest = builds[-1]["key"]
    return f"https://build.protomaps.com/{latest}"


def download_rd5_segments(segments):
    SEGMENTS_DIR.mkdir(parents=True, exist_ok=True)
    for seg in segments:
        dest = SEGMENTS_DIR / f"{seg}.rd5"
        tmp = dest.with_suffix(".rd5.tmp")
        url = f"{BROUTER_SEGMENTS_URL}/{seg}.rd5"
        print(f"Downloading {url} -> {dest}...", flush=True)
        req = urllib.request.Request(url, headers={"User-Agent": "rsrouter-r2-sync"})
        with urllib.request.urlopen(req, timeout=180) as resp, open(tmp, "wb") as out:
            shutil.copyfileobj(resp, out)
        tmp.rename(dest)


def extract_pmtiles_segments(segments, planet_url: str):
    if not PMTILES_CLI.exists():
        raise FileNotFoundError(f"pmtiles CLI not found at {PMTILES_CLI}")
    MAP_TILES_DIR.mkdir(parents=True, exist_ok=True)
    for seg in segments:
        out_path = MAP_TILES_DIR / f"{seg}.pmtiles"
        tmp_path = MAP_TILES_DIR / f"{seg}.pmtiles.tmp"
        bbox = ",".join(str(x) for x in parse_segment_bbox(seg))
        print(f"Extracting {seg}.pmtiles (bbox={bbox}) from {planet_url}...", flush=True)
        run([
            str(PMTILES_CLI),
            "extract",
            planet_url,
            str(tmp_path),
            f"--bbox={bbox}",
            "--maxzoom=14",
        ])
        tmp_path.rename(out_path)


def setup_bucket(bucket: str, domain: str, zone_id: str):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
        json.dump(CORS_RULES, tf, indent=2)
        cors_file = tf.name
    try:
        run(["npx", "wrangler", "r2", "bucket", "cors", "set", bucket, "--file", cors_file, "-y"])
    finally:
        os.unlink(cors_file)

    if zone_id:
        subprocess.run(
            ["npx", "wrangler", "r2", "bucket", "domain", "add", bucket, "--domain", domain, "--zone-id", zone_id, "-y"],
            check=False,
        )
    subprocess.run(["npx", "wrangler", "r2", "bucket", "dev-url", "disable", bucket, "-y"], check=False)


def upload_small_file(bucket: str, key: str, filepath: Path, content_type: str):
    run([
        "npx",
        "wrangler",
        "r2",
        "object",
        "put",
        f"{bucket}/{key}",
        "--file",
        str(filepath),
        "--content-type",
        content_type,
        "--remote",
    ])


def upload_large_files_via_worker(bucket: str, files_to_upload):
    if not files_to_upload:
        return
    worker_host = "upload-tmp.surita.dev"
    edge_ip = "104.21.28.92"
    base_url = f"https://{worker_host}"
    chunk_size = 50 * 1024 * 1024  # 50 MiB

    with tempfile.TemporaryDirectory() as tmpdir:
        worker_js = Path(tmpdir) / "worker.js"
        wrangler_toml = Path(tmpdir) / "wrangler.toml"
        worker_js.write_text(MULTIPART_WORKER_JS)
        wrangler_toml.write_text(
            f'name = "gbrouter-uploader-tmp"\n'
            f'main = "{worker_js}"\n'
            f'compatibility_date = "2024-10-01"\n'
            f'routes = [{{ pattern = "{worker_host}", custom_domain = true }}]\n\n'
            f'[[r2_buckets]]\n'
            f'binding = "BUCKET"\n'
            f'bucket_name = "{bucket}"\n'
        )
        run(["npx", "wrangler", "deploy", "-c", str(wrangler_toml)])
        try:
            for key, filepath, content_type in files_to_upload:
                size_mb = filepath.stat().st_size / (1024 * 1024)
                print(f"Multipart uploading {key} ({size_mb:.1f} MiB)...", flush=True)
                create_cmd = [
                    "curl", "-sf", "--resolve", f"{worker_host}:443:{edge_ip}",
                    "-X", "POST",
                    f"{base_url}/?action=create&key={urllib.parse.quote(key)}&type={urllib.parse.quote(content_type)}",
                ]
                upload_id = json.loads(subprocess.check_output(create_cmd).decode())["uploadId"]
                parts = []
                with open(filepath, "rb") as f:
                    part_num = 1
                    while True:
                        chunk = f.read(chunk_size)
                        if not chunk:
                            break
                        part_file = Path(tmpdir) / f"part_{part_num}.bin"
                        part_file.write_bytes(chunk)
                        try:
                            print(f"  Part {part_num} ({len(chunk) / (1024 * 1024):.1f} MiB)...", flush=True)
                            part_url = (
                                f"{base_url}/?action=part&key={urllib.parse.quote(key)}"
                                f"&uploadId={urllib.parse.quote(upload_id)}&partNumber={part_num}"
                            )
                            part_out = subprocess.check_output([
                                "curl", "-sf", "--resolve", f"{worker_host}:443:{edge_ip}",
                                "-X", "PUT",
                                "--data-binary", f"@{part_file}",
                                "-H", "Content-Type: application/octet-stream",
                                part_url,
                            ])
                            parts.append(json.loads(part_out.decode()))
                        finally:
                            part_file.unlink(missing_ok=True)
                        part_num += 1

                comp_url = (
                    f"{base_url}/?action=complete&key={urllib.parse.quote(key)}"
                    f"&uploadId={urllib.parse.quote(upload_id)}"
                )
                subprocess.check_output([
                    "curl", "-sf", "--resolve", f"{worker_host}:443:{edge_ip}",
                    "-X", "POST",
                    "-H", "Content-Type: application/json",
                    "-d", json.dumps(parts),
                    comp_url,
                ])
                print(f"Completed {key}.", flush=True)
        finally:
            subprocess.run(["npx", "wrangler", "delete", "-c", str(wrangler_toml), "--force"], check=False)


def upload_files(bucket: str, segments, upload_rd5: bool, upload_pmtiles: bool):
    max_single_put = 290 * 1024 * 1024  # 290 MiB
    large_queue = []

    if upload_rd5:
        for seg in segments:
            fp = SEGMENTS_DIR / f"{seg}.rd5"
            if not fp.exists():
                continue
            key = f"segments4/{seg}.rd5"
            if fp.stat().st_size > max_single_put:
                large_queue.append((key, fp, "application/octet-stream"))
            else:
                upload_small_file(bucket, key, fp, "application/octet-stream")

    if upload_pmtiles:
        for seg in segments:
            fp = MAP_TILES_DIR / f"{seg}.pmtiles"
            if not fp.exists():
                continue
            key = f"map-tiles/{seg}.pmtiles"
            if fp.stat().st_size > max_single_put:
                large_queue.append((key, fp, "application/vnd.pmtiles"))
            else:
                upload_small_file(bucket, key, fp, "application/vnd.pmtiles")

    upload_large_files_via_worker(bucket, large_queue)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", default=DEFAULT_BUCKET)
    parser.add_argument("--domain", default=DEFAULT_DOMAIN)
    parser.add_argument("--zone-id", default=DEFAULT_ZONE_ID)
    parser.add_argument("--segments", nargs="*", default=UK_SEGMENTS)
    parser.add_argument("--setup-bucket", action="store_true", help="Configure R2 CORS, custom domain, and disable r2.dev.")
    parser.add_argument("--rd5", action="store_true", help="Download latest .rd5 segments from brouter.de and upload to R2.")
    parser.add_argument("--pmtiles", action="store_true", help="Extract latest .pmtiles from Protomaps planet build and upload to R2.")
    parser.add_argument("--upload-only", action="store_true", help="Upload already-present local files without downloading/extracting.")
    parser.add_argument("--planet-url", default=None, help="Explicit Protomaps planet .pmtiles URL (defaults to latest build).")
    args = parser.parse_args()

    if args.setup_bucket:
        setup_bucket(args.bucket, args.domain, args.zone_id)

    do_rd5 = args.rd5 or (not args.rd5 and not args.pmtiles and not args.setup_bucket)
    do_pmtiles = args.pmtiles

    if not args.upload_only:
        if do_rd5:
            download_rd5_segments(args.segments)
        if do_pmtiles:
            planet = args.planet_url or latest_protomaps_build_url()
            extract_pmtiles_segments(args.segments, planet)

    if do_rd5 or do_pmtiles:
        upload_files(args.bucket, args.segments, do_rd5, do_pmtiles)


if __name__ == "__main__":
    main()
