import { haversine } from './geo.ts';

export interface ComparedRoute {
  name: string;
  distanceM: number;
  ascentM: number;
  descentM: number;
  durationS?: number;
  /** [lon, lat, ele?] */
  coordinates: number[][];
  /** Distance from start per vertex in meters */
  dist: number[];
  /** Elevation per vertex in meters */
  ele: number[];
  geojson: GeoJSON.FeatureCollection;
}

export function parseGpx(xmlText: string): ComparedRoute {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    throw new Error('Invalid GPX XML format');
  }

  const nameEl = doc.querySelector('trk > name') || doc.querySelector('metadata > name') || doc.querySelector('name');
  const name = nameEl?.textContent?.trim() || 'Recorded Route';

  let ptEls = Array.from(doc.querySelectorAll('trkpt'));
  if (ptEls.length === 0) ptEls = Array.from(doc.querySelectorAll('rtept'));
  if (ptEls.length === 0) ptEls = Array.from(doc.querySelectorAll('wpt'));

  if (ptEls.length < 2) {
    throw new Error('GPX contains fewer than 2 route points');
  }

  const coordinates: number[][] = [];
  const ele: number[] = [];
  const timestamps: number[] = [];
  const dist: number[] = [0];

  for (const el of ptEls) {
    const lat = parseFloat(el.getAttribute('lat') || '');
    const lon = parseFloat(el.getAttribute('lon') || '');
    if (isNaN(lat) || isNaN(lon)) continue;

    const eleEl = el.querySelector('ele');
    const altitude = eleEl ? parseFloat(eleEl.textContent || '') : undefined;
    const timeEl = el.querySelector('time');
    const timeMs = timeEl ? Date.parse(timeEl.textContent || '') : NaN;

    if (altitude !== undefined && !isNaN(altitude)) {
      coordinates.push([lon, lat, altitude]);
      ele.push(altitude);
    } else {
      coordinates.push([lon, lat]);
      ele.push(0);
    }

    if (!isNaN(timeMs)) {
      timestamps.push(timeMs);
    }

    if (coordinates.length > 1) {
      const prev = coordinates[coordinates.length - 2];
      const curr = coordinates[coordinates.length - 1];
      const d = haversine(prev[1], prev[0], curr[1], curr[0]);
      dist.push(dist[dist.length - 1] + d);
    }
  }

  if (coordinates.length < 2) {
    throw new Error('Valid coordinates in GPX fewer than 2 points');
  }

  const distanceM = dist[dist.length - 1] || 0;

  let ascentM = 0;
  let descentM = 0;
  for (let i = 1; i < ele.length; i++) {
    const diff = ele[i] - ele[i - 1];
    if (diff > 0.5) ascentM += diff;
    else if (diff < -0.5) descentM += Math.abs(diff);
  }

  let durationS: number | undefined;
  if (timestamps.length >= 2) {
    const totalMs = timestamps[timestamps.length - 1] - timestamps[0];
    if (totalMs > 0) durationS = Math.round(totalMs / 1000);
  }

  const geojson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          name,
          distanceM,
          ascentM,
          descentM,
          durationS,
        },
        geometry: {
          type: 'LineString',
          coordinates,
        },
      },
    ],
  };

  return {
    name,
    distanceM,
    ascentM,
    descentM,
    durationS,
    coordinates,
    dist,
    ele,
    geojson,
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function routeToGpx(geojson: GeoJSON.FeatureCollection, trackName: string): string {
  const feat = geojson.features[0];
  if (!feat || !feat.geometry) {
    return '';
  }

  const props = (feat.properties || {}) as Record<string, any>;
  const lengthM = Number(props['track-length']) || 0;
  const distKm = (lengthM / 1000).toFixed(2);
  const timeMin = Math.round((Number(props['total-time']) || 0) / 60);
  const ascendM = Math.round(Number(props['filtered ascend']) || 0);

  const coords = (feat.geometry as GeoJSON.LineString).coordinates || [];
  const trkpts = coords
    .map(([lon, lat, ele]) => {
      const eleXml =
        ele !== undefined && ele !== null
          ? `\n        <ele>${Number(ele).toFixed(2)}</ele>`
          : '';
      return `      <trkpt lat="${Number(lat).toFixed(6)}" lon="${Number(lon).toFixed(6)}">${eleXml}\n      </trkpt>`;
    })
    .join('\n');

  const escapedName = escapeXml(trackName);

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="rsrouter"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapedName}</name>
    <desc>Distance: ${distKm} km, Time: ${timeMin} min, Ascend: ${ascendM} m</desc>
  </metadata>
  <trk>
    <name>${escapedName}</name>
    <desc>Distance: ${distKm} km, Time: ${timeMin} min, Ascend: ${ascendM} m</desc>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

export function downloadGpxFile(content: string, filename: string) {
  const blob = new Blob([content], { type: 'application/gpx+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
