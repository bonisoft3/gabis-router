import { defineConfig, type Connect } from 'vite';
import react from '@vitejs/plugin-react';
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
      '/segments4': {
        target: 'https://brouter.de/brouter/segments4',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/segments4/, ''),
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
      '/segments4': {
        target: 'https://brouter.de/brouter/segments4',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/segments4/, ''),
      },
    },
  },
  plugins: [
    react(),
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
      name: 'pmtiles-extractor',
      configureServer(server) {
        server.middlewares.use(serveMapTiles);
      },
      configurePreviewServer(server) {
        server.middlewares.use(serveMapTiles);
      },
    },
    {
      name: 'mcp-bridge',
      configureServer(server) {
        const pending = new Map<
          string,
          { resolve: (val: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
        >();
        let reqSeq = 0;
        let bridgeReady = false;
        const readyWaiters = new Set<() => void>();

        server.ws.on('mcp:ready', () => {
          bridgeReady = true;
          for (const resolve of readyWaiters) resolve();
          readyWaiters.clear();
        });

        server.ws.on('mcp:result', (data: any) => {
          if (!data || !data.id) return;
          const entry = pending.get(data.id);
          if (!entry) return;
          clearTimeout(entry.timer);
          pending.delete(data.id);
          if (data.ok) {
            entry.resolve(data.result);
          } else {
            entry.reject(new Error(data.error || 'Unknown browser MCP error'));
          }
        });

        server.middlewares.use('/__mcp', (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                status: 'ok',
                bridge: 'vite-mcp',
                connectedTabs: server.ws.clients.size,
                bridgeReady,
              }),
            );
            return;
          }

          if (server.ws.clients.size === 0) {
            res.statusCode = 503;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                ok: false,
                error:
                  'No browser tab is connected to Vite HMR. Open or refresh https://localhost:3000 in your browser.',
              }),
            );
            return;
          }

          let rawBody = '';
          req.on('data', (chunk) => {
            rawBody += chunk;
          });
          req.on('end', async () => {
            try {
              if (!bridgeReady) {
                await new Promise<void>((resolve) => {
                  const t = setTimeout(resolve, 4000);
                  readyWaiters.add(() => {
                    clearTimeout(t);
                    resolve();
                  });
                  server.ws.send({ type: 'full-reload', path: '*' });
                });
              }

              const payload = JSON.parse(rawBody || '{}');
              const command = String(payload.command || 'get_state');
              const args = { ...(payload.args || {}) };

              if (command === 'compare_gpx' && args.filePath && !args.gpxContent) {
                const resolved = path.isAbsolute(args.filePath)
                  ? args.filePath
                  : path.resolve(__dirname, '..', args.filePath);
                const text = fs.readFileSync(resolved, 'utf8');
                if (resolved.endsWith('.json')) {
                  const geo = JSON.parse(text);
                  const coords: number[][] = geo.features?.[0]?.geometry?.coordinates || [];
                  const name = path.basename(resolved, '.json');
                  const pts = coords
                    .map(
                      (c) =>
                        `<trkpt lat="${c[1]}" lon="${c[0]}">${c[2] !== undefined ? `<ele>${c[2]}</ele>` : ''}</trkpt>`,
                    )
                    .join('');
                  args.gpxContent = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1"><trk><name>${name}</name><trkseg>${pts}</trkseg></trk></gpx>`;
                } else {
                  args.gpxContent = text;
                }
              }

              const id = `mcp_${Date.now()}_${++reqSeq}`;
              const timeoutMs = Number(payload.timeoutMs || 15000);

              const result: any = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                  pending.delete(id);
                  reject(
                    new Error(
                      'Timed out waiting for browser response. Please refresh https://localhost:3000 so the new MCP bridge hook loads.',
                    ),
                  );
                }, timeoutMs);
                pending.set(id, { resolve, reject, timer });
                server.ws.send('mcp:command', { id, command, args });
              });

              if (command === 'screenshot' && result && typeof result.dataUrl === 'string') {
                const base64 = result.dataUrl.replace(/^data:image\/png;base64,/, '');
                const outPath = args.outPath
                  ? path.isAbsolute(args.outPath)
                    ? args.outPath
                    : path.resolve(__dirname, '..', args.outPath)
                  : path.join(__dirname, 'mcp-screenshot.png');
                fs.mkdirSync(path.dirname(outPath), { recursive: true });
                fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({
                    ok: true,
                    result: {
                      path: outPath,
                      width: result.width,
                      height: result.height,
                    },
                  }),
                );
                return;
              }

              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true, result }));
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  ok: false,
                  error: err?.message || String(err),
                }),
              );
            }
          });
        });
      },
    },
  ],
  build: {
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
});
