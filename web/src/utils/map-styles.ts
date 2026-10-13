import type maplibregl from 'maplibre-gl';
import * as protomapsThemesBase from 'protomaps-themes-base';
import type { Basemap } from '../basemap.ts';

export const FONT_BASE_URL = 'https://cdn.protomaps.com/fonts/pbf/';
export const FONT_NAMES = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];
// Basic Latin plus Latin-1 and Latin Extended-A, which covers Welsh (ŵ, ŷ) and Irish names.
export const FONT_RANGES = ['0-255', '256-511'];

export const ROUTING_FILES = [
  '/profiles/lookups.dat',
  '/profiles/fastbike.brf',
  '/profiles/fastbike-lowtraffic.brf',
  '/profiles/fastbike-verylowtraffic.brf',
  '/profiles/gabis-lite-gravel.brf',
  '/profiles/gabis-safe-road.brf',
  '/profiles/gravel.brf',
  '/profiles/trekking.brf',
];

export const UK_CENTER: [number, number] = [-4.5, 54.5];
export const UK_BOUNDS: [[number, number], [number, number]] = [
  [-15.0, 49.0], // Southwest: west of Ireland, Scilly
  [4.0, 61.5], // Northeast: Shetland, East Anglia
];

export function getOfflineStyle(): maplibregl.StyleSpecification {
  const layers = protomapsThemesBase.default('protomaps', 'light', 'en') as any[];

  // Road and land tweaks tuned for the light theme.
  for (const l of layers) {
    if (l.id === 'landcover') {
      l.paint = l.paint || {};
      l.paint['fill-opacity'] = ['interpolate', ['linear'], ['zoom'], 5, 1, 7, 0.6, 9, 0.3, 11, 0];
    } else if (l.id === 'landuse_park') {
      l.paint = l.paint || {};
      l.paint['fill-opacity'] = ['interpolate', ['linear'], ['zoom'], 6, 0.3, 8, 0.6, 11, 1];
    } else if (l.id === 'roads_major_casing_early') {
      l.paint = l.paint || {};
      l.paint['line-color'] = '#b8b2a8';
      l.paint['line-width'] = ['interpolate', ['exponential', 1.6], ['zoom'], 6, 0.4, 8, 0.8, 10, 1.1, 12, 1.3];
      l.paint['line-gap-width'] = ['interpolate', ['exponential', 1.6], ['zoom'], 6, 0.4, 8, 0.8, 12, 1.6];
    } else if (l.id === 'roads_major_casing_late') {
      l.paint = l.paint || {};
      l.paint['line-color'] = '#b8b2a8';
    } else if (l.id === 'roads_major') {
      l.paint = l.paint || {};
      l.paint['line-width'] = ['interpolate', ['exponential', 1.6], ['zoom'], 6, 0.6, 8, 1.0, 12, 1.6, 15, 3, 18, 13];
    } else if (l.id === 'roads_highway_casing_early') {
      l.paint = l.paint || {};
      l.paint['line-color'] = '#c49a6c';
      l.paint['line-width'] = ['interpolate', ['exponential', 1.6], ['zoom'], 4, 0.5, 7, 0.9, 12, 1.4];
      l.paint['line-gap-width'] = ['interpolate', ['exponential', 1.6], ['zoom'], 3, 0.3, 6, 1.0, 12, 1.8];
    } else if (l.id === 'roads_highway_casing_late') {
      l.paint = l.paint || {};
      l.paint['line-color'] = '#c49a6c';
    } else if (l.id === 'roads_highway') {
      l.paint = l.paint || {};
      l.paint['line-color'] = '#fcd0a1';
      l.paint['line-width'] = ['interpolate', ['exponential', 1.6], ['zoom'], 3, 0.6, 6, 1.3, 8, 1.8, 12, 2.2, 15, 5, 18, 15];
    }
  }

  return {
    version: 8,
    glyphs: `${FONT_BASE_URL.replace(/^https:\/\//, 'offline-tile://')}{fontstack}/{range}.pbf`,
    sources: {
      protomaps: {
        type: 'vector',
        tiles: ['pmtiles-composite://{z}/{x}/{y}.pbf'],
        minzoom: 0,
        maxzoom: 14,
        attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
    },
    layers: layers as any,
  };
}

export const ONLINE_STYLE_URL = 'https://tiles.openfreemap.org/styles/bright';

export const CYCLOSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    cyclosm: {
      type: 'raster',
      tiles: [
        'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
        'https://b.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
        'https://c.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors. Tiles courtesy of <a href="https://www.cyclosm.org" target="_blank" rel="noopener">CyclOSM</a>',
    },
  },
  layers: [
    {
      id: 'cyclosm-tiles',
      type: 'raster',
      source: 'cyclosm',
      minzoom: 0,
      maxzoom: 19,
    },
  ],
};

export function getOpenCycleMapStyle(apiKey?: string): maplibregl.StyleSpecification {
  const query = apiKey ? `?apikey=${encodeURIComponent(apiKey)}` : '';
  return {
    version: 8,
    sources: {
      opencyclemap: {
        type: 'raster',
        tiles: [
          `https://a.tile.thunderforest.com/cycle/{z}/{x}/{y}.png${query}`,
          `https://b.tile.thunderforest.com/cycle/{z}/{x}/{y}.png${query}`,
          `https://c.tile.thunderforest.com/cycle/{z}/{x}/{y}.png${query}`,
        ],
        tileSize: 256,
        maxzoom: 18,
        attribution:
          'Maps © <a href="https://www.thunderforest.com/" target="_blank" rel="noopener">Thunderforest</a>, Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
      },
    },
    layers: [
      {
        id: 'opencyclemap-tiles',
        type: 'raster',
        source: 'opencyclemap',
        minzoom: 0,
        maxzoom: 18,
      },
    ],
  };
}

export function getOnlineStyle(basemap: Basemap, thunderforestKey?: string): string | maplibregl.StyleSpecification {
  if (basemap === 'cyclosm') {
    return CYCLOSM_STYLE;
  }
  if (basemap === 'opencyclemap') {
    return getOpenCycleMapStyle(thunderforestKey);
  }
  return ONLINE_STYLE_URL;
}
