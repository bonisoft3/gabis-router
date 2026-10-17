#!/usr/bin/env node
// MCP server and CLI client for the rsrouter live frontend bridge.
// Speaks JSON-RPC 2.0 over stdio when invoked with no arguments, or executes a
// single tool call when invoked as:
//   node tools/mcp-frontend.mjs call <tool_name> '<json_args>'

import http from 'node:http';
import https from 'node:https';
import readline from 'node:readline';

const VITE_PORT = Number(process.env.RSROUTER_WEB_PORT || 3000);
const VITE_HOST = process.env.RSROUTER_WEB_HOST || '127.0.0.1';

const TOOLS = [
  {
    name: 'ui_get_state',
    description:
      'Read the live state of the rsrouter browser tab: waypoints, profile, avoid areas, route summary (distance, ascent, time, cost, surface/road breakdown, displayed DOM strings), compared GPX route, UI drawer states, and MapLibre camera/layer metrics.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ui_set_route',
    description:
      'Set waypoints, routing profile, alternative index (0..3), or avoid areas in the live browser tab and wait for WASM route calculation and MapLibre rendering to finish.',
    inputSchema: {
      type: 'object',
      properties: {
        waypoints: {
          type: 'array',
          description: 'List of waypoints [{ lat, lon, name? }]',
          items: {
            type: 'object',
            properties: {
              lat: { type: 'number' },
              lon: { type: 'number' },
              name: { type: 'string' },
            },
            required: ['lat', 'lon'],
          },
        },
        profile: {
          type: 'string',
          description:
            'Routing profile name, e.g. fastbike-lowtraffic, fastbike-verylowtraffic, fastbike, gravel, trekking, mtb, shortest',
        },
        alternativeIdx: {
          type: 'number',
          description: 'Alternative route index (0 = Primary, 1 = Alt 2, 2 = Alt 3, 3 = Alt 4)',
        },
        avoidAreas: {
          type: 'array',
          description: 'Avoid areas [{ lat, lon, radius? }]',
          items: {
            type: 'object',
            properties: {
              lat: { type: 'number' },
              lon: { type: 'number' },
              radius: { type: 'number' },
            },
            required: ['lat', 'lon'],
          },
        },
        fitBounds: {
          type: 'boolean',
          description: 'Whether to fit map bounds to the route (default true)',
        },
        waitForRoute: {
          type: 'boolean',
          description: 'Wait for route computation and map idle before returning (default true)',
        },
      },
    },
  },
  {
    name: 'ui_interact',
    description:
      'Perform a user interaction in the live browser UI: add/move/remove/rename waypoints, reverse/clear route, add/remove avoid areas, select alternative, hover route distance, highlight surface/road category, toggle drawers, change settings (units/theme/basemap/offlineMode), undo/redo, or click a DOM selector.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'add_waypoint',
            'move_waypoint',
            'remove_waypoint',
            'rename_waypoint',
            'reverse_route',
            'clear_route',
            'add_avoid_area',
            'remove_avoid_area',
            'clear_avoid_areas',
            'select_alternative',
            'hover_route_distance',
            'highlight_category',
            'toggle_controls',
            'toggle_route_info',
            'toggle_settings',
            'toggle_about',
            'set_settings',
            'set_viewport',
            'import_gpx',
            'undo',
            'redo',
            'click_selector',
          ],
        },
        lat: { type: 'number' },
        lon: { type: 'number' },
        name: { type: 'string' },
        mode: { type: 'string', enum: ['start', 'end', 'via', 'append'] },
        index: { type: 'number' },
        radius: { type: 'number' },
        alternativeIdx: { type: 'number' },
        distanceMeters: { type: ['number', 'null'] },
        kind: { type: 'string', enum: ['surface', 'road', 'clear'] },
        category: { type: 'string' },
        collapsed: { type: 'boolean' },
        open: { type: 'boolean' },
        units: { type: 'string', enum: ['km', 'mi'] },
        theme: { type: 'string', enum: ['light', 'dark', 'auto'] },
        basemap: { type: 'string' },
        offlineMode: { type: 'boolean' },
        width: { type: ['number', 'null'] },
        height: { type: ['number', 'null'] },
        gpxContent: { type: 'string' },
        toleranceM: { type: 'number' },
        selector: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'ui_compare_gpx',
    description:
      'Load a GPX file or BRouter GeoJSON fixture into the live app for visual and metric route comparison, or clear the active comparison.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            'Path to a .gpx file or a .json GeoJSON fixture (e.g. fixtures/brouter_de/clapham_hackney_fastbike.json)',
        },
        gpxContent: {
          type: 'string',
          description: 'Raw GPX XML string if not loading from filePath',
        },
        matchStartAndEnd: {
          type: 'boolean',
          description: 'Snap the app start and end waypoints to match the GPX endpoints',
        },
        clear: {
          type: 'boolean',
          description: 'Clear the currently loaded comparison route',
        },
      },
    },
  },
  {
    name: 'ui_map_camera',
    description: 'Move the MapLibre camera to a specific center/zoom or fit the active route bounds.',
    inputSchema: {
      type: 'object',
      properties: {
        center: {
          type: 'object',
          properties: {
            lon: { type: 'number' },
            lat: { type: 'number' },
          },
          required: ['lon', 'lat'],
        },
        zoom: { type: 'number' },
        fitBounds: { type: 'boolean' },
      },
    },
  },
  {
    name: 'ui_screenshot',
    description:
      'Capture a full composite PNG screenshot of the open browser tab (combining the MapLibre WebGL canvas and all HTML/SVG UI overlays) and save it to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        outPath: {
          type: 'string',
          description: 'Optional output path for the PNG file (defaults to web/mcp-screenshot.png)',
        },
      },
    },
  },
  {
    name: 'ui_journey_log',
    description:
      'Retrieve or clear the recorded log of MCP actions and state transitions from the current session so it can be turned into an automated E2E test.',
    inputSchema: {
      type: 'object',
      properties: {
        clear: { type: 'boolean' },
      },
    },
  },
];

const TOOL_TO_COMMAND = {
  ui_get_state: 'get_state',
  ui_set_route: 'set_route',
  ui_interact: 'interact',
  ui_compare_gpx: 'compare_gpx',
  ui_map_camera: 'map_camera',
  ui_screenshot: 'screenshot',
  ui_journey_log: 'journey_log',
};

function postToVite(protocol, payload) {
  const client = protocol === 'https' ? https : http;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        hostname: VITE_HOST,
        port: VITE_PORT,
        path: '/__mcp',
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (!parsed.ok) {
              const appErr = new Error(parsed.error || `HTTP ${res.statusCode}`);
              appErr.isAppError = true;
              reject(appErr);
            } else {
              resolve(parsed.result);
            }
          } catch {
            reject(new Error(`Invalid response from Vite /__mcp: ${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callViteBridge(toolName, args = {}) {
  const command = TOOL_TO_COMMAND[toolName];
  if (!command) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  const payload = { command, args };
  try {
    return await postToVite('https', payload);
  } catch (httpsErr) {
    if (httpsErr.isAppError) throw httpsErr;
    return await postToVite('http', payload);
  }
}

// CLI mode: `node tools/mcp-frontend.mjs call <tool_name> [json_args]`
if (process.argv[2] === 'call') {
  const toolName = process.argv[3] || 'ui_get_state';
  const rawArgs = process.argv[4] ? JSON.parse(process.argv[4]) : {};
  callViteBridge(toolName, rawArgs)
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
    })
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
} else {
  // Stdio MCP Server mode
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  function sendResponse(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  function sendError(id, code, message) {
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n',
    );
  }

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    const { id, method, params } = msg;
    if (method === 'initialize') {
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'rsrouter-frontend-mcp', version: '0.1.0' },
      });
    } else if (method === 'notifications/initialized') {
      // No response required for notifications
    } else if (method === 'tools/list') {
      sendResponse(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const result = await callViteBridge(toolName, toolArgs);
        sendResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        sendResponse(id, {
          isError: true,
          content: [{ type: 'text', text: err.message || String(err) }],
        });
      }
    } else if (id !== undefined) {
      sendError(id, -32601, `Method not found: ${method}`);
    }
  });
}
