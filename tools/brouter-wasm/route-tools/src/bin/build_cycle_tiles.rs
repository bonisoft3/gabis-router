//! Builds `web/map-tiles/cycle_routes.pmtiles` directly from BRouter `.rd5` segments.
//!
//! Extracts all ways tagged with `route_bicycle_icn`, `route_bicycle_ncn`, `route_bicycle_rcn`,
//! `route_bicycle_lcn`, `ncn`, `rcn`, `lcn`, and `route_mtb_*` across the 7 UK & Ireland
//! `.rd5` segments and writes a PMTiles v3 vector tile archive (`cycle_routes` layer, zooms 5..11).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::PathBuf;

use brouter_rs::dsl::lookups::LookupData;
use brouter_rs::rd5::tile_manager::TileManager;

const UK_SEGMENTS: &[(&str, i32, i32)] = &[
    ("W15_N50", -15, 50),
    ("W10_N50", -10, 50),
    ("W10_N55", -10, 55),
    ("W5_N50", -5, 50),
    ("W5_N55", -5, 55),
    ("W5_N60", -5, 60),
    ("E0_N50", 0, 50),
    ("W50_S25", -50, -25),
];

const MIN_ZOOM: u8 = 5;
const MAX_ZOOM: u8 = 11;
const EXTENT: f64 = 4096.0;
const BUFFER: i32 = 64;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum CycleNetwork {
    Icn = 0,
    Ncn = 1,
    Rcn = 2,
    Lcn = 3,
    Mtb = 4,
}

impl CycleNetwork {
    fn min_zoom(self) -> u8 {
        match self {
            Self::Icn | Self::Ncn => 5,
            Self::Rcn => 7,
            Self::Lcn | Self::Mtb => 8,
        }
    }
}

struct ExtractedWay {
    network: CycleNetwork,
    proposed: bool,
    ref_idx: u32,
    /// Normalized Web Mercator coordinates `(mx, my)` in `[0.0, 1.0]`.
    mercator_pts: Vec<(f64, f64)>,
    min_mx: f64,
    max_mx: f64,
    min_my: f64,
    max_my: f64,
}

fn lookup_seg_ref(
    seg_refs: &HashMap<u64, u32>,
    ilon1: i32,
    ilat1: i32,
    ilon2: i32,
    ilat2: i32,
) -> u32 {
    let base_mx = (ilon1 as i64 + ilon2 as i64).div_euclid(8);
    let base_my = (ilat1 as i64 + ilat2 as i64).div_euclid(8);
    let k0 = ((base_mx as u32 as u64) << 32) | (base_my as u32 as u64);
    if let Some(&idx) = seg_refs.get(&k0) {
        return idx;
    }
    for dx in -1..=1 {
        for dy in -1..=1 {
            if dx == 0 && dy == 0 {
                continue;
            }
            let k = (((base_mx + dx) as u32 as u64) << 32) | ((base_my + dy) as u32 as u64);
            if let Some(&idx) = seg_refs.get(&k) {
                return idx;
            }
        }
    }
    0
}

fn load_cycle_refs(path: &std::path::Path) -> io::Result<(Vec<String>, HashMap<u64, u32>)> {
    if !path.exists() {
        return Ok((Vec::new(), HashMap::new()));
    }
    let data = fs::read(path)?;
    if data.len() < 12 || &data[0..4] != b"CREF" {
        return Ok((Vec::new(), HashMap::new()));
    }
    let num_strings = u32::from_le_bytes(data[4..8].try_into().unwrap()) as usize;
    let num_entries = u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize;
    let mut pos = 12usize;
    let mut strings = Vec::with_capacity(num_strings);
    for _ in 0..num_strings {
        let len = u16::from_le_bytes(data[pos..pos + 2].try_into().unwrap()) as usize;
        pos += 2;
        let s = String::from_utf8_lossy(&data[pos..pos + len]).into_owned();
        pos += len;
        strings.push(s);
    }
    let mut map = HashMap::with_capacity(num_entries);
    for _ in 0..num_entries {
        let k = u64::from_le_bytes(data[pos..pos + 8].try_into().unwrap());
        let idx = u32::from_le_bytes(data[pos + 8..pos + 12].try_into().unwrap());
        pos += 12;
        map.insert(k, idx + 1);
    }
    eprintln!(
        "Loaded {} cycle route ref labels across {} segments from {:?}",
        strings.len(),
        map.len(),
        path
    );
    Ok((strings, map))
}

fn ilon_ilat_to_mercator(ilon: i32, ilat: i32) -> (f64, f64) {
    let lon = (ilon as f64) / 1_000_000.0 - 180.0;
    let lat = (ilat as f64) / 1_000_000.0 - 90.0;
    let mx = (lon + 180.0) / 360.0;
    let lat_rad = lat.to_radians();
    let my = (1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / std::f64::consts::PI) * 0.5;
    (mx, my)
}

fn rotate(n: u64, x: u64, y: u64, rx: u64, ry: u64) -> (u64, u64) {
    if ry == 0 {
        if rx != 0 {
            return (n - 1 - y, n - 1 - x);
        }
        return (y, x);
    }
    (x, y)
}

fn zxy_to_tile_id(z: u8, x: u32, y: u32) -> u64 {
    let z64 = z as u64;
    let base = ((1u64 << (2 * z64)) - 1) / 3;
    let mut acc = base;
    let mut tx = x as u64;
    let mut ty = y as u64;
    if z == 0 {
        return 0;
    }
    let mut s = 1u64 << (z64 - 1);
    while s > 0 {
        let rx = if (tx & s) != 0 { 1 } else { 0 };
        let ry = if (ty & s) != 0 { 1 } else { 0 };
        acc += ((3 * rx) ^ ry) * s * s;
        let (nx, ny) = rotate(s, tx, ty, rx, ry);
        tx = nx;
        ty = ny;
        s >>= 1;
    }
    acc
}

fn write_varint(buf: &mut Vec<u8>, mut val: u64) {
    while val >= 0x80 {
        buf.push(((val & 0x7f) as u8) | 0x80);
        val >>= 7;
    }
    buf.push(val as u8);
}

fn zigzag(n: i32) -> u64 {
    ((n << 1) ^ (n >> 31)) as u32 as u64
}

fn encode_string_field(buf: &mut Vec<u8>, field_num: u32, s: &str) {
    write_varint(buf, ((field_num << 3) | 2) as u64);
    write_varint(buf, s.len() as u64);
    buf.extend_from_slice(s.as_bytes());
}

fn encode_mvt_value_string(buf: &mut Vec<u8>, s: &str) {
    let mut inner = Vec::with_capacity(s.len() + 2);
    encode_string_field(&mut inner, 1, s);
    write_varint(buf, ((4 << 3) | 2) as u64);
    write_varint(buf, inner.len() as u64);
    buf.extend_from_slice(&inner);
}

/// Deduplicates directed edges within a tile and chains connected segments into polylines.
fn merge_tile_lines(lines: Vec<Vec<(i32, i32)>>) -> Vec<Vec<(i32, i32)>> {
    let mut unique_edges: HashSet<((i32, i32), (i32, i32))> = HashSet::new();
    let mut adj: HashMap<(i32, i32), Vec<(i32, i32)>> = HashMap::new();
    let mut in_deg: HashMap<(i32, i32), usize> = HashMap::new();

    for pts in lines {
        for w in pts.windows(2) {
            let a = w[0];
            let b = w[1];
            if a == b {
                continue;
            }
            let canon = if a < b { (a, b) } else { (b, a) };
            if unique_edges.insert(canon) {
                adj.entry(a).or_default().push(b);
                *in_deg.entry(b).or_default() += 1;
                in_deg.entry(a).or_default();
            }
        }
    }

    let mut merged = Vec::new();
    let nodes: Vec<(i32, i32)> = in_deg.keys().copied().collect();

    // First start chains from non-intermediate nodes (in_deg != 1 or out_deg != 1)
    for start in &nodes {
        let in_d = in_deg.get(start).copied().unwrap_or(0);
        let out_d = adj.get(start).map(|v| v.len()).unwrap_or(0);
        if in_d == 1 && out_d == 1 {
            continue;
        }
        while let Some(next) = adj.get_mut(start).and_then(|v| v.pop()) {
            let mut chain = vec![*start, next];
            let mut cur = next;
            while in_deg.get(&cur).copied().unwrap_or(0) == 1
                && adj.get(&cur).map(|v| v.len()).unwrap_or(0) == 1
            {
                let nxt = adj.get_mut(&cur).unwrap().pop().unwrap();
                chain.push(nxt);
                cur = nxt;
            }
            merged.push(chain);
        }
    }

    // Any remaining cycles (in_deg == 1 && out_deg == 1)
    for start in &nodes {
        while let Some(next) = adj.get_mut(start).and_then(|v| v.pop()) {
            let mut chain = vec![*start, next];
            let mut cur = next;
            while let Some(nxt) = adj.get_mut(&cur).and_then(|v| v.pop()) {
                chain.push(nxt);
                cur = nxt;
            }
            merged.push(chain);
        }
    }

    merged
}

/// Encodes a single tile's grouped polylines into an MVT protobuf byte buffer.
fn encode_mvt_tile(
    groups: &BTreeMap<(CycleNetwork, bool, u32), Vec<Vec<(i32, i32)>>>,
    ref_strings: &[String],
) -> Vec<u8> {
    let mut layer = Vec::new();
    // field 15: version = 2
    write_varint(&mut layer, ((15 << 3) | 0) as u64);
    write_varint(&mut layer, 2);
    // field 1: name = "cycle_routes"
    encode_string_field(&mut layer, 1, "cycle_routes");
    // field 5: extent = EXTENT
    write_varint(&mut layer, ((5 << 3) | 0) as u64);
    write_varint(&mut layer, EXTENT as u64);

    // Keys: 0 = "network", 1 = "state", 2 = "ref"
    encode_string_field(&mut layer, 3, "network");
    encode_string_field(&mut layer, 3, "state");
    encode_string_field(&mut layer, 3, "ref");

    // Fixed values: 0="icn", 1="ncn", 2="rcn", 3="lcn", 4="mtb", 5="actual", 6="proposed"
    for v in ["icn", "ncn", "rcn", "lcn", "mtb", "actual", "proposed"] {
        encode_mvt_value_string(&mut layer, v);
    }

    // Dynamic ref values used in this tile (indices >= 7)
    let mut ref_val_map: HashMap<u32, u64> = HashMap::new();
    let mut next_val_idx = 7u64;
    for &(_, _, ref_idx) in groups.keys() {
        if ref_idx > 0 && !ref_val_map.contains_key(&ref_idx) {
            if let Some(s) = ref_strings.get((ref_idx - 1) as usize) {
                encode_mvt_value_string(&mut layer, s);
                ref_val_map.insert(ref_idx, next_val_idx);
                next_val_idx += 1;
            }
        }
    }

    let mut geom_buf = Vec::new();
    let mut tags_buf = Vec::new();
    let mut feat_buf = Vec::new();

    for (&(net, proposed, ref_idx), lines) in groups {
        geom_buf.clear();
        let mut cur_x = 0i32;
        let mut cur_y = 0i32;
        let mut valid_lines = 0usize;

        for pts in lines {
            if pts.len() < 2 {
                continue;
            }
            valid_lines += 1;
            // MoveTo(1) -> (1 << 3) | 1 = 9
            write_varint(&mut geom_buf, 9);
            let dx0 = pts[0].0 - cur_x;
            let dy0 = pts[0].1 - cur_y;
            write_varint(&mut geom_buf, zigzag(dx0));
            write_varint(&mut geom_buf, zigzag(dy0));
            cur_x = pts[0].0;
            cur_y = pts[0].1;

            // LineTo(pts.len() - 1)
            let count = (pts.len() - 1) as u64;
            write_varint(&mut geom_buf, (count << 3) | 2);
            for &(px, py) in &pts[1..] {
                let dx = px - cur_x;
                let dy = py - cur_y;
                write_varint(&mut geom_buf, zigzag(dx));
                write_varint(&mut geom_buf, zigzag(dy));
                cur_x = px;
                cur_y = py;
            }
        }

        if valid_lines == 0 {
            continue;
        }

        tags_buf.clear();
        // key 0 ("network") -> net as u64
        write_varint(&mut tags_buf, 0);
        write_varint(&mut tags_buf, net as u64);
        // key 1 ("state") -> 5 ("actual") or 6 ("proposed")
        write_varint(&mut tags_buf, 1);
        write_varint(&mut tags_buf, if proposed { 6 } else { 5 });
        // key 2 ("ref") -> dynamic ref value index (if present)
        if let Some(&v_idx) = ref_val_map.get(&ref_idx) {
            write_varint(&mut tags_buf, 2);
            write_varint(&mut tags_buf, v_idx);
        }

        feat_buf.clear();
        // field 2: tags (packed varint)
        write_varint(&mut feat_buf, ((2 << 3) | 2) as u64);
        write_varint(&mut feat_buf, tags_buf.len() as u64);
        feat_buf.extend_from_slice(&tags_buf);
        // field 3: type = 2 (LINESTRING)
        write_varint(&mut feat_buf, ((3 << 3) | 0) as u64);
        write_varint(&mut feat_buf, 2);
        // field 4: geometry (packed varint)
        write_varint(&mut feat_buf, ((4 << 3) | 2) as u64);
        write_varint(&mut feat_buf, geom_buf.len() as u64);
        feat_buf.extend_from_slice(&geom_buf);

        // Layer field 2: features
        write_varint(&mut layer, ((2 << 3) | 2) as u64);
        write_varint(&mut layer, feat_buf.len() as u64);
        layer.extend_from_slice(&feat_buf);
    }

    let mut tile = Vec::with_capacity(layer.len() + 8);
    // Tile field 3: layers
    write_varint(&mut tile, ((3 << 3) | 2) as u64);
    write_varint(&mut tile, layer.len() as u64);
    tile.extend_from_slice(&layer);
    tile
}

struct DirEntry {
    tile_id: u64,
    offset: u64,
    length: u32,
    run_length: u32,
}

fn serialize_directory(entries: &[DirEntry]) -> Vec<u8> {
    let mut out = Vec::new();
    write_varint(&mut out, entries.len() as u64);
    let mut last_id = 0u64;
    for e in entries {
        write_varint(&mut out, e.tile_id - last_id);
        last_id = e.tile_id;
    }
    for e in entries {
        write_varint(&mut out, e.run_length as u64);
    }
    for e in entries {
        write_varint(&mut out, e.length as u64);
    }
    for (i, e) in entries.iter().enumerate() {
        if i > 0 && e.offset == entries[i - 1].offset + (entries[i - 1].length as u64) {
            write_varint(&mut out, 0);
        } else {
            write_varint(&mut out, e.offset + 1);
        }
    }
    out
}

fn main() -> io::Result<()> {
    let args: Vec<String> = env::args().collect();
    let segments_dir = args
        .get(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data/segments4"));
    let lookups_path = args
        .get(2)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("web/public/profiles/lookups.dat"));
    let out_path = args
        .get(3)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("web/map-tiles/cycle_routes.pmtiles"));

    let lookups = LookupData::load_from_file(&lookups_path)?;
    let way_lu = &lookups.way;

    let icn_idxs: Vec<usize> = ["route_bicycle_icn", "icn"]
        .iter()
        .filter_map(|k| way_lu.get_name_idx(k))
        .collect();
    let ncn_idxs: Vec<usize> = ["route_bicycle_ncn", "ncn", "route_mtb_ncn"]
        .iter()
        .filter_map(|k| way_lu.get_name_idx(k))
        .collect();
    let rcn_idxs: Vec<usize> = ["route_bicycle_rcn", "rcn", "route_mtb_rcn"]
        .iter()
        .filter_map(|k| way_lu.get_name_idx(k))
        .collect();
    let lcn_idxs: Vec<usize> = [
        "route_bicycle_lcn",
        "lcn",
        "route_mtb_lcn",
        "route_bicycle_",
        "route_bicycle_radweit",
    ]
    .iter()
    .filter_map(|k| way_lu.get_name_idx(k))
    .collect();
    let mtb_idxs: Vec<usize> = ["route_bicycle_mtb", "route_mtb_mtb", "route_mtb_"]
        .iter()
        .filter_map(|k| way_lu.get_name_idx(k))
        .collect();

    let mut tm = TileManager::with_cache_capacity(&segments_dir, 0);
    let mut ld = vec![0i32; way_lu.names.len()];
    let mut ways: Vec<ExtractedWay> = Vec::new();
    let (ref_strings, seg_refs) = load_cycle_refs(std::path::Path::new("data/cycle_refs.bin"))?;
    let mut matched_ref_ways = 0usize;

    for &(seg_name, base_lon, base_lat) in UK_SEGMENTS {
        let seg_file = segments_dir.join(format!("{}.rd5", seg_name));
        if !seg_file.exists() {
            eprintln!("Skipping missing segment {:?}", seg_file);
            continue;
        }
        eprintln!("Scanning {}...", seg_name);
        let lon_deg_base = base_lon + 180;
        let lat_deg_base = base_lat + 90;

        for dlon in 0..5 {
            for dlat in 0..5 {
                let cells =
                    tm.decode_all_in_square(lon_deg_base + dlon, lat_deg_base + dlat, None)?;
                for mc in cells {
                    for node in &mc.nodes {
                        for link in &node.links {
                            if link.is_reverse {
                                continue;
                            }
                            let Some(ref tags) = link.way_tags else {
                                continue;
                            };
                            way_lu.decode_into(&mut ld, false, &tags.data);

                            let check = |idxs: &[usize]| -> Option<bool> {
                                let mut found_proposed = false;
                                for &idx in idxs {
                                    let v = ld[idx];
                                    if v == 2 {
                                        return Some(false);
                                    } else if v == 3 {
                                        found_proposed = true;
                                    }
                                }
                                if found_proposed {
                                    Some(true)
                                } else {
                                    None
                                }
                            };

                            let matched = if let Some(p) = check(&icn_idxs) {
                                Some((CycleNetwork::Icn, p))
                            } else if let Some(p) = check(&ncn_idxs) {
                                Some((CycleNetwork::Ncn, p))
                            } else if let Some(p) = check(&rcn_idxs) {
                                Some((CycleNetwork::Rcn, p))
                            } else if let Some(p) = check(&lcn_idxs) {
                                Some((CycleNetwork::Lcn, p))
                            } else {
                                check(&mtb_idxs).map(|p| (CycleNetwork::Mtb, p))
                            };

                            let Some((network, proposed)) = matched else {
                                continue;
                            };

                            let mut mercator_pts = Vec::with_capacity(link.geometry.len() + 2);
                            let (mut min_mx, mut max_mx) = (f64::INFINITY, f64::NEG_INFINITY);
                            let (mut min_my, mut max_my) = (f64::INFINITY, f64::NEG_INFINITY);

                            let mut push_pt = |ilon: i32, ilat: i32| {
                                let (mx, my) = ilon_ilat_to_mercator(ilon, ilat);
                                min_mx = min_mx.min(mx);
                                max_mx = max_mx.max(mx);
                                min_my = min_my.min(my);
                                max_my = max_my.max(my);
                                mercator_pts.push((mx, my));
                            };

                            let mut found_ref_idx = 0u32;
                            push_pt(node.ilon, node.ilat);
                            let mut cur_lon = node.ilon;
                            let mut cur_lat = node.ilat;
                            for g in &link.geometry {
                                let next_lon = cur_lon + g.dlon;
                                let next_lat = cur_lat + g.dlat;
                                if found_ref_idx == 0 && !seg_refs.is_empty() {
                                    found_ref_idx = lookup_seg_ref(
                                        &seg_refs, cur_lon, cur_lat, next_lon, next_lat,
                                    );
                                }
                                cur_lon = next_lon;
                                cur_lat = next_lat;
                                push_pt(cur_lon, cur_lat);
                            }
                            if found_ref_idx == 0 && !seg_refs.is_empty() {
                                found_ref_idx = lookup_seg_ref(
                                    &seg_refs,
                                    cur_lon,
                                    cur_lat,
                                    link.target_lon,
                                    link.target_lat,
                                );
                            }
                            push_pt(link.target_lon, link.target_lat);

                            let ref_idx = found_ref_idx;
                            if ref_idx > 0 {
                                matched_ref_ways += 1;
                            }
                            ways.push(ExtractedWay {
                                network,
                                proposed,
                                ref_idx,
                                mercator_pts,
                                min_mx,
                                max_mx,
                                min_my,
                                max_my,
                            });
                        }
                    }
                }
            }
        }
    }

    let mut counts: BTreeMap<CycleNetwork, usize> = BTreeMap::new();
    for w in &ways {
        *counts.entry(w.network).or_default() += 1;
    }
    eprintln!(
        "Extracted {} cycling way segments ({} with ref labels): {:?}",
        ways.len(),
        matched_ref_ways,
        counts
    );

    // Build tiles across zooms MIN_ZOOM..=MAX_ZOOM, keyed by Hilbert tile_id
    let mut encoded_tiles: BTreeMap<u64, Vec<u8>> = BTreeMap::new();

    for z in MIN_ZOOM..=MAX_ZOOM {
        let n = (1u32 << z) as f64;
        let max_tile = (1u32 << z) - 1;
        let mut z_tiles: BTreeMap<
            (u32, u32),
            BTreeMap<(CycleNetwork, bool, u32), Vec<Vec<(i32, i32)>>>,
        > = BTreeMap::new();

        for way in &ways {
            if z < way.network.min_zoom() {
                continue;
            }
            let x0 = ((way.min_mx * n).floor() as i64).clamp(0, max_tile as i64) as u32;
            let x1 = ((way.max_mx * n).floor() as i64).clamp(0, max_tile as i64) as u32;
            let y0 = ((way.min_my * n).floor() as i64).clamp(0, max_tile as i64) as u32;
            let y1 = ((way.max_my * n).floor() as i64).clamp(0, max_tile as i64) as u32;

            for tx in x0..=x1 {
                for ty in y0..=y1 {
                    let mut pts: Vec<(i32, i32)> = Vec::with_capacity(way.mercator_pts.len());
                    let mut inside_any = false;
                    for &(mx, my) in &way.mercator_pts {
                        let px = ((mx * n - (tx as f64)) * EXTENT).round() as i32;
                        let py = ((my * n - (ty as f64)) * EXTENT).round() as i32;
                        if px >= -BUFFER
                            && px <= (EXTENT as i32) + BUFFER
                            && py >= -BUFFER
                            && py <= (EXTENT as i32) + BUFFER
                        {
                            inside_any = true;
                        }
                        if pts.last().copied() != Some((px, py)) {
                            pts.push((px, py));
                        }
                    }
                    if inside_any && pts.len() >= 2 {
                        z_tiles
                            .entry((tx, ty))
                            .or_default()
                            .entry((way.network, way.proposed, way.ref_idx))
                            .or_default()
                            .push(pts);
                    }
                }
            }
        }

        eprintln!("Zoom {}: {} non-empty tiles", z, z_tiles.len());
        for ((tx, ty), mut groups) in z_tiles {
            for lines in groups.values_mut() {
                *lines = merge_tile_lines(std::mem::take(lines));
            }
            let tile_id = zxy_to_tile_id(z, tx, ty);
            let mvt = encode_mvt_tile(&groups, &ref_strings);
            encoded_tiles.insert(tile_id, mvt);
        }
    }

    // Build leaf directory and tile data payload
    let mut leaf_entries = Vec::with_capacity(encoded_tiles.len());
    let mut tile_data = Vec::new();
    for (&tile_id, bytes) in &encoded_tiles {
        let offset = tile_data.len() as u64;
        let length = bytes.len() as u32;
        tile_data.extend_from_slice(bytes);
        leaf_entries.push(DirEntry {
            tile_id,
            offset,
            length,
            run_length: 1,
        });
    }

    let leaf_dir_bytes = serialize_directory(&leaf_entries);
    let root_entries = vec![DirEntry {
        tile_id: 0,
        offset: 0,
        length: leaf_dir_bytes.len() as u32,
        run_length: 0,
    }];
    let root_dir_bytes = serialize_directory(&root_entries);

    let metadata_json = br#"{"name":"rsrouter-cycle-routes","description":"UK and Ireland OSM cycling routes (ICN, NCN, RCN, LCN, MTB)","version":"1.0.0","type":"overlay","format":"pbf","vector_layers":[{"id":"cycle_routes","fields":{"network":"String","state":"String","ref":"String"},"minzoom":5,"maxzoom":11}]}"#;

    let root_dir_offset = 127u64;
    let root_dir_len = root_dir_bytes.len() as u64;
    let metadata_offset = root_dir_offset + root_dir_len;
    let metadata_len = metadata_json.len() as u64;
    let leaf_dir_offset = metadata_offset + metadata_len;
    let leaf_dir_len = leaf_dir_bytes.len() as u64;
    let tile_data_offset = leaf_dir_offset + leaf_dir_len;
    let tile_data_len = tile_data.len() as u64;
    let num_tiles = leaf_entries.len() as u64;

    let mut header = [0u8; 127];
    header[0..7].copy_from_slice(b"PMTiles");
    header[7] = 3; // spec_version = 3
    header[8..16].copy_from_slice(&root_dir_offset.to_le_bytes());
    header[16..24].copy_from_slice(&root_dir_len.to_le_bytes());
    header[24..32].copy_from_slice(&metadata_offset.to_le_bytes());
    header[32..40].copy_from_slice(&metadata_len.to_le_bytes());
    header[40..48].copy_from_slice(&leaf_dir_offset.to_le_bytes());
    header[48..56].copy_from_slice(&leaf_dir_len.to_le_bytes());
    header[56..64].copy_from_slice(&tile_data_offset.to_le_bytes());
    header[64..72].copy_from_slice(&tile_data_len.to_le_bytes());
    header[72..80].copy_from_slice(&num_tiles.to_le_bytes());
    header[80..88].copy_from_slice(&num_tiles.to_le_bytes());
    header[88..96].copy_from_slice(&num_tiles.to_le_bytes());
    header[96] = 1; // clustered = true
    header[97] = 1; // internal_compression = None (1)
    header[98] = 1; // tile_compression = None (1)
    header[99] = 1; // tile_type = Mvt (1)
    header[100] = MIN_ZOOM;
    header[101] = MAX_ZOOM;
    header[102..106].copy_from_slice(&(-500_000_000i32).to_le_bytes()); // minLon = -50.0
    header[106..110].copy_from_slice(&(-250_000_000i32).to_le_bytes()); // minLat = -25.0
    header[110..114].copy_from_slice(&(50_000_000i32).to_le_bytes()); // maxLon = 5.0
    header[114..118].copy_from_slice(&(650_000_000i32).to_le_bytes()); // maxLat = 65.0
    header[118] = 6; // centerZoom = 6
    header[119..123].copy_from_slice(&(-25_000_000i32).to_le_bytes()); // centerLon = -2.5
    header[123..127].copy_from_slice(&(540_000_000i32).to_le_bytes()); // centerLat = 54.0

    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut f = BufWriter::new(File::create(&out_path)?);
    f.write_all(&header)?;
    f.write_all(&root_dir_bytes)?;
    f.write_all(metadata_json)?;
    f.write_all(&leaf_dir_bytes)?;
    f.write_all(&tile_data)?;
    f.flush()?;

    eprintln!(
        "Wrote {:?} ({} tiles, {:.2} MiB)",
        out_path,
        num_tiles,
        (tile_data_offset + tile_data_len) as f64 / (1024.0 * 1024.0)
    );
    Ok(())
}
