# rsrouter Web Frontend

Progressive Web App (PWA) for browser-based bicycle routing powered by WebAssembly.

## Architecture

| Component | Technology | Role |
| :--- | :--- | :--- |
| UI & Map | TypeScript, MapLibre GL JS | Renders map view, handles click waypoints, displays GeoJSON routes. |
| Routing Worker | Web Worker (`worker.ts`) | Runs route calculation off the main thread to prevent UI freezing. |
| Engine | `rsrouter-wasm` (WebAssembly) | In-memory graph loading and A* path computation. |
| Offline Cache | Service Worker (`sw.js`) | Caches the app shell (HTML, JS, CSS, `.wasm`, icons) so the app opens offline. Routing data and map tiles are cached by the app code. |

## Directory Layout

```text
web/
├── index.html              # App entrypoint
├── package.json            # Dependencies and scripts
├── tsconfig.json           # TypeScript configuration
├── vite.config.ts          # Vite build configuration
├── map-tiles/              # .pmtiles archives, extracted on first request (dev server, not copied to dist)
├── public/
│   ├── manifest.json       # PWA metadata
│   ├── sw.js               # Service Worker
│   └── favicon.svg
└── src/
    ├── main.ts             # Map rendering, UI, offline download
    ├── worker.ts           # Routing Web Worker
    ├── download-worker.ts  # Streams map tile archives to browser storage (OPFS)
    └── types.ts            # Data contracts and messages
```

## Setup and Development

Prerequisites: Node.js 18+ and npm.

```bash
cd web
npm install
npm run dev
```

The app will be available at `http://localhost:3000`.

### Production Build

```bash
cd web
npm run build
```

## How It Works

1. The user clicks two or more locations on the map.
2. `main.ts` sends a `ROUTE_REQUEST` message to `worker.ts`.
3. `worker.ts` executes the A* search inside WebAssembly and returns GeoJSON.
4. `main.ts` draws the route polyline onto the MapLibre GL layer.
5. The Service Worker caches downloaded map tiles and segment files in browser storage for offline routing.
