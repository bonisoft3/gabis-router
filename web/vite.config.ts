import { defineConfig, type Connect } from 'vite';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { createHash } from 'crypto';

const certDir = path.join(__dirname, '.cert');
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');
const hasHttpsCerts = fs.existsSync(keyPath) && fs.existsSync(certPath);

// Map tile archives. Outside public/ on purpose: they are over 1 GB and must not be
// copied into dist/ on every build.
const mapTilesDir = path.join(__dirname, 'map-tiles');
const pmtilesCli = path.resolve(__dirname, '..', 'tools', 'pmtiles');
const PLANET_PMTILES = 'https://build.protomaps.com/20261001.pmtiles';

const activeExtractions = new Map<string, Promise<void>>();

// Extracts one 5°×5° segment at zoom 0-14. Writes to a temp file and renames on success,
// so an interrupted extraction never leaves a partial archive that would then be served.
function extractSegment(segmentId: string, bbox: number[], outPath: string): Promise<void> {
  const running = activeExtractions.get(segmentId);
  if (running) return running;

  if (!fs.existsSync(pmtilesCli)) {
    return Promise.reject(new Error('pmtiles CLI not found at tools/pmtiles'));
  }
  fs.mkdirSync(mapTilesDir, { recursive: true });
  const tmpPath = `${outPath}.tmp`;

  const promise = new Promise<void>((resolve, reject) => {
    console.log(`[PMTiles extract] ${segmentId} bbox=${bbox.join(',')} maxzoom=14`);
    const child = spawn(pmtilesCli, [
      'extract',
      PLANET_PMTILES,
      tmpPath,
      `--bbox=${bbox.join(',')}`,
      '--maxzoom=14',
      '--quiet',
    ]);
    child.stderr?.on('data', (d) => console.log(`[pmtiles ${segmentId}] ${d}`));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        fs.renameSync(tmpPath, outPath);
        console.log(`[PMTiles extract] ${segmentId} done`);
        resolve();
      } else {
        fs.rmSync(tmpPath, { force: true });
        reject(new Error(`pmtiles extract exited with code ${code}`));
      }
    });
  });

  activeExtractions.set(segmentId, promise);
  promise.finally(() => activeExtractions.delete(segmentId)).catch(() => {});
  return promise;
}

// Missing segments must 404. Otherwise the SPA fallback answers with index.html.
const segmentsNotFound: Connect.NextHandleFunction = (req, res, next) => {
  if (req.url && req.url.startsWith('/segments4/') && req.url.endsWith('.rd5')) {
    const relPath = req.url.split('?')[0];
    const localPath = path.join(__dirname, 'public', relPath);
    if (!fs.existsSync(localPath)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Segment not found locally');
      return;
    }
  }
  next();
};

// Serves /map-tiles/<segment>.pmtiles from web/map-tiles/, extracting it from the
// Protomaps planet build on first request.
const serveMapTiles: Connect.NextHandleFunction = async (req, res, next) => {
  if (!req.url || !req.url.startsWith('/map-tiles/')) {
    return next();
  }

  const rawUrl = req.url.split('?')[0];
  const match = rawUrl.match(/^\/map-tiles\/(([EW])(\d+)_([NS])(\d+))\.pmtiles$/);
  if (!match) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end(`Unknown map tile segment: ${rawUrl}`);
    return;
  }

  const segmentId = match[1];
  const localPath = path.join(mapTilesDir, `${segmentId}.pmtiles`);

  if (!fs.existsSync(localPath)) {
    const minLon = match[2] === 'W' ? -parseInt(match[3], 10) : parseInt(match[3], 10);
    const minLat = match[4] === 'S' ? -parseInt(match[5], 10) : parseInt(match[5], 10);
    try {
      await extractSegment(segmentId, [minLon, minLat, minLon + 5, minLat + 5], localPath);
    } catch (err: any) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain');
      res.end(`Failed to extract PMTiles for ${segmentId}: ${err.message}`);
      return;
    }
  }

  const { size } = fs.statSync(localPath);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/vnd.pmtiles');
  res.setHeader('Content-Length', String(size));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(localPath).pipe(res);
};

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 3000,
    https: hasHttpsCerts
      ? {
          key: fs.readFileSync(keyPath),
          cert: fs.readFileSync(certPath),
        }
      : undefined,
    proxy: {
      '/remote-segments': {
        target: 'https://brouter.de/brouter/segments4',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/remote-segments/, ''),
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
    https: hasHttpsCerts
      ? {
          key: fs.readFileSync(keyPath),
          cert: fs.readFileSync(certPath),
        }
      : undefined,
    proxy: {
      '/remote-segments': {
        target: 'https://brouter.de/brouter/segments4',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/remote-segments/, ''),
      },
    },
  },
  plugins: [
    {
      // Fill the service worker precache list with the built files so the app opens offline.
      name: 'sw-precache',
      apply: 'build',
      writeBundle(options, bundle) {
        const swPath = path.join(options.dir!, 'sw.js');
        const files = Object.keys(bundle).filter((f) => f !== 'index.html');
        const urls = [
          ...files.map((f) => `/${f}`),
          '/manifest.json',
          '/favicon.svg',
          '/icon-192.png',
          '/icon-512.png',
          '/apple-touch-icon.png',
        ];
        const version = createHash('sha256').update(files.sort().join('\n')).digest('hex').slice(0, 12);
        const src = fs.readFileSync(swPath, 'utf8');
        const out = src
          .replace("const APP_CACHE_VERSION = 'dev';", `const APP_CACHE_VERSION = '${version}';`)
          .replace('const PRECACHE_URLS = [];', `const PRECACHE_URLS = ${JSON.stringify(urls)};`);
        if (out === src) {
          throw new Error('sw-precache: placeholders not found in sw.js');
        }
        fs.writeFileSync(swPath, out);
      },
    },
    {
      name: 'prevent-spa-fallback-on-segments',
      configureServer(server) {
        server.middlewares.use(segmentsNotFound);
      },
      configurePreviewServer(server) {
        server.middlewares.use(segmentsNotFound);
      },
    },
    {
      name: 'pmtiles-extractor',
      configureServer(server) {
        server.middlewares.use(serveMapTiles);
      },
      configurePreviewServer(server) {
        server.middlewares.use(serveMapTiles);
      },
    },
  ],
  worker: {
    format: 'es',
  },
});
