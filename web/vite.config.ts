import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const activeExtractions = new Map<string, Promise<void>>();

export default defineConfig({
  server: {
    port: 3000,
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
      name: 'prevent-spa-fallback-on-segments',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.startsWith('/segments4/') && req.url.endsWith('.rd5')) {
            const relPath = req.url.split('?')[0];
            const localPath = path.join(__dirname, 'public', relPath);
            if (!fs.existsSync(localPath)) {
              // File is not present locally on disk in public/segments4/!
              // Return 404 rather than letting Vite's SPA fallback return index.html!
              res.statusCode = 404;
              res.setHeader('Content-Type', 'text/plain');
              res.end('Segment not found locally');
              return;
            }
          }
          next();
        });
      },
    },
    {
      name: 'pmtiles-extractor',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url || !req.url.startsWith('/map-tiles/')) {
            return next();
          }

          const rawUrl = req.url.split('?')[0];
          const match = rawUrl.match(/^\/map-tiles\/([A-Za-z0-9_]+)\.pmtiles$/);
          if (!match) {
            return next();
          }

          const segmentId = match[1];
          const mapTilesDir = path.join(__dirname, 'public', 'map-tiles');
          const localPath = path.join(mapTilesDir, `${segmentId}.pmtiles`);

          // If file already exists, let Vite serve it
          if (fs.existsSync(localPath)) {
            return next();
          }

          // Validate coordinate segment format
          const coordMatch = segmentId.match(/^([EW])(\d+)_([NS])(\d+)$/);
          if (!coordMatch) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain');
            res.end(`Unknown map tile segment: ${segmentId}`);
            return;
          }

          const lonDir = coordMatch[1];
          const lonVal = parseInt(coordMatch[2], 10);
          const latDir = coordMatch[3];
          const latVal = parseInt(coordMatch[4], 10);
          const minLon = lonDir === 'W' ? -lonVal : lonVal;
          const minLat = latDir === 'S' ? -latVal : latVal;
          const maxLon = minLon + 5;
          const maxLat = minLat + 5;

          const pmtilesCli = path.resolve(__dirname, '..', 'tools', 'pmtiles');
          if (!fs.existsSync(pmtilesCli)) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain');
            res.end('pmtiles CLI tool not found in tools/pmtiles');
            return;
          }

          fs.mkdirSync(mapTilesDir, { recursive: true });

          // Deduplicate concurrent extraction requests for the same segment
          if (!activeExtractions.has(segmentId)) {
            const extractionPromise = new Promise<void>((resolve, reject) => {
              console.log(
                `[PMTiles extract] Starting extraction for ${segmentId} (bbox: ${minLon},${minLat},${maxLon},${maxLat}) maxzoom: 14...`,
              );
              const child = spawn(pmtilesCli, [
                'extract',
                'https://build.protomaps.com/20261001.pmtiles',
                localPath,
                `--bbox=${minLon},${minLat},${maxLon},${maxLat}`,
                '--maxzoom=14',
              ]);

              child.stdout?.on('data', (d) => console.log(`[pmtiles ${segmentId}] ${d}`));
              child.stderr?.on('data', (d) => console.log(`[pmtiles ${segmentId}] ${d}`));

              child.on('close', (code) => {
                if (code === 0) {
                  console.log(`[PMTiles extract] Finished ${segmentId}.pmtiles successfully`);
                  resolve();
                } else {
                  console.error(`[PMTiles extract] Failed with code ${code}`);
                  reject(new Error(`pmtiles extract failed with code ${code}`));
                }
              });

              child.on('error', (err) => {
                console.error(`[PMTiles extract] Process error:`, err);
                reject(err);
              });
            });

            activeExtractions.set(segmentId, extractionPromise);
            extractionPromise.finally(() => activeExtractions.delete(segmentId));
          }

          try {
            await activeExtractions.get(segmentId);
            return next();
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain');
            res.end(`Failed to extract PMTiles for ${segmentId}: ${err.message}`);
          }
        });
      },
    },
  ],
  worker: {
    format: 'es',
  },
});
