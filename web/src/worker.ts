import type { RouteRequest, RouteResponse, WorkerMessage } from './types.ts';

// Dedicated Web Worker running rsrouter WebAssembly off the main UI thread.

let isInitialized = false;

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'INIT': {
      try {
        postMessage({ type: 'STATUS', message: 'Loading WebAssembly engine...' });
        // In the full build, this imports the wasm-bindgen pkg:
        // const wasm = await import('../../crates/rsrouter-wasm/pkg');
        // await wasm.default();
        isInitialized = true;
        postMessage({ type: 'STATUS', message: 'Router ready.' });
      } catch (err) {
        postMessage({
          type: 'STATUS',
          message: `Failed to initialize engine: ${String(err)}`,
        });
      }
      break;
    }

    case 'ROUTE_REQUEST': {
      if (!isInitialized) {
        postMessage({
          type: 'ROUTE_ERROR',
          id: msg.id,
          error: 'Router not initialized yet.',
        });
        return;
      }

      try {
        const { waypoints, profile, alternativeIdx } = msg.payload;
        postMessage({
          type: 'STATUS',
          message: `Computing route (${waypoints.length} points, ${profile})...`,
        });

        // Placeholder for WASM routing call:
        // const geojsonStr = router.find_route(waypoints, profile, alternativeIdx ?? 0);
        // const response: RouteResponse = JSON.parse(geojsonStr);

        const dummyResponse: RouteResponse = {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {
                'track-length': '0',
                'total-time': '0',
                cost: '0',
                'filtered ascend': '0',
              },
              geometry: {
                type: 'LineString',
                coordinates: waypoints.map((w) => [w.lon, w.lat]),
              },
            },
          ],
        };

        postMessage({
          type: 'ROUTE_SUCCESS',
          id: msg.id,
          payload: dummyResponse,
        });
      } catch (err) {
        postMessage({
          type: 'ROUTE_ERROR',
          id: msg.id,
          error: String(err),
        });
      }
      break;
    }
  }
};
