// Pure Jessie-compatible domain logic for GBRouter:
// - Surface, road, traffic, noise, and speed-limit classification
// - Metric and imperial distance, elevation, duration, and speed formatting
// - Undo/redo history stack
// - GPX XML generation and hysteresis-filtered elevation calculation
// - Elevation profile and surface breakdown model builders

export const SURFACE_META = {
  paved: { label: 'Paved', color: '#10b981' },
  gravel: { label: 'Gravel', color: '#f59e0b' },
  unpaved: { label: 'Unpaved', color: '#d97706' },
  trail: { label: 'Trail', color: '#854d0e' },
  cobblestone: { label: 'Cobblestone', color: '#8b5cf6' },
  unknown: { label: 'Unknown', color: '#94a3b8' },
};

export const ROAD_META = {
  cycleway: { label: 'Cycleway', color: '#06b6d4' },
  residential: { label: 'Residential', color: '#10b981' },
  tertiary: { label: 'Tertiary', color: '#eab308' },
  secondary: { label: 'Secondary', color: '#f97316' },
  primary: { label: 'Primary', color: '#ef4444' },
  path: { label: 'Path', color: '#854d0e' },
  unknown: { label: 'Unknown', color: '#94a3b8' },
};

export const TRAFFIC_META = {
  traffic_free: { label: 'Traffic-free', color: '#059669' },
  low: { label: 'Low', color: '#84cc16' },
  acceptable: { label: 'Acceptable', color: '#f59e0b' },
  heavy: { label: 'Heavy', color: '#ef4444' },
};

export const NOISE_META = {
  very_quiet: { label: 'Low', color: '#10b981' },
  moderate: { label: 'Moderate', color: '#f59e0b' },
  loud: { label: 'High', color: '#ef4444' },
};

export const SPEED_LIMIT_META = {
  car_free: { label: 'Car-free', color: '#059669' },
  '20mph': { label: '20 mph', color: '#10b981' },
  '30mph': { label: '30 mph', color: '#84cc16' },
  '40mph': { label: '40 mph', color: '#eab308' },
  '50mph': { label: '50 mph', color: '#f97316' },
  '60mph': { label: '60 mph', color: '#ef4444' },
  '70mph': { label: '70 mph', color: '#991b1b' },
  untagged: { label: 'Untagged', color: '#94a3b8' },
};

export function classifySurface(surface, highway) {
  const s = String(surface || '').toLowerCase().trim();
  const h = String(highway || '').toLowerCase().trim();

  if (['asphalt', 'paved', 'concrete', 'concrete:lanes', 'concrete:plates', 'tarmac'].includes(s)) {
    return 'paved';
  }
  if (['cobblestone', 'cobblestone:flattened', 'sett', 'paving_stones'].includes(s)) {
    return 'cobblestone';
  }
  if (['gravel', 'fine_gravel', 'compacted', 'pebblestone'].includes(s)) {
    return 'gravel';
  }
  if (['dirt', 'earth', 'ground', 'mud', 'sand', 'clay'].includes(s)) {
    return 'trail';
  }
  if (['unpaved', 'wood', 'metal', 'grass', 'grass_paver'].includes(s)) {
    return 'unpaved';
  }

  if (
    [
      'motorway',
      'trunk',
      'primary',
      'secondary',
      'tertiary',
      'residential',
      'living_street',
      'service',
      'cycleway',
      'pedestrian',
    ].includes(h)
  ) {
    return 'paved';
  }
  if (h === 'track') {
    return 'gravel';
  }
  if (['path', 'footway', 'bridleway', 'steps'].includes(h)) {
    return 'trail';
  }

  return 'unknown';
}

export function classifyRoad(highway) {
  const h = String(highway || '').toLowerCase().trim();
  if (h === 'cycleway') return 'cycleway';
  if (['residential', 'living_street', 'service', 'unclassified'].includes(h)) return 'residential';
  if (['tertiary', 'tertiary_link'].includes(h)) return 'tertiary';
  if (['secondary', 'secondary_link'].includes(h)) return 'secondary';
  if (['primary', 'primary_link', 'trunk', 'trunk_link', 'motorway', 'motorway_link'].includes(h)) {
    return 'primary';
  }
  if (['path', 'footway', 'bridleway', 'track', 'steps', 'pedestrian'].includes(h)) return 'path';
  return 'unknown';
}

export function classifyTraffic(traffic, highway) {
  const h = String(highway || '').toLowerCase().trim();
  if (['cycleway', 'path', 'footway', 'pedestrian', 'bridleway', 'track', 'steps'].includes(h)) {
    return 'traffic_free';
  }
  const t = Number(traffic || 0);
  if (t >= 4) return 'heavy';
  if (t >= 2) return 'acceptable';
  return 'low';
}

export function classifyNoise(noise) {
  const n = Number(noise || 0);
  if (n >= 4) return 'loud';
  if (n >= 2) return 'moderate';
  return 'very_quiet';
}

export function classifySpeedLimit(maxspeed, highway) {
  const h = String(highway || '').toLowerCase().trim();
  if (['cycleway', 'path', 'footway', 'pedestrian', 'bridleway', 'track', 'steps'].includes(h)) {
    return 'car_free';
  }
  const spd = Number(maxspeed || 0);
  if (spd > 0) {
    if (spd <= 35) return '20mph';
    if (spd <= 55) return '30mph';
    if (spd <= 75) return '40mph';
    if (spd <= 95) return '50mph';
    if (spd <= 105) return '60mph';
    return '70mph';
  }
  return 'untagged';
}

const M_PER_MILE = 1609.344;
const FT_PER_M = 3.28084;

export function formatDistance(meters, units = 'metric') {
  if (units === 'imperial') {
    const miles = meters / M_PER_MILE;
    return `${miles.toFixed(miles < 10 ? 2 : 1)} mi`;
  }
  return meters < 1000
    ? `${Math.round(meters)} m`
    : `${(meters / 1000).toFixed(meters < 10000 ? 2 : 1)} km`;
}

export function formatElevation(meters, units = 'metric') {
  return units === 'imperial' ? `${Math.round(meters * FT_PER_M)} ft` : `${Math.round(meters)} m`;
}

export function formatDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

export function formatSpeed(meters, seconds, units = 'metric') {
  if (seconds <= 0 || meters <= 0) return units === 'imperial' ? '0.0 mph' : '0.0 km/h';
  const hours = seconds / 3600;
  if (units === 'imperial') {
    const mph = meters / M_PER_MILE / hours;
    return `${mph.toFixed(1)} mph`;
  }
  const kmh = meters / 1000 / hours;
  return `${kmh.toFixed(1)} km/h`;
}

export class HistoryStack {
  constructor(maxDepth = 50) {
    this.undoStack = [];
    this.redoStack = [];
    this.maxDepth = maxDepth;
  }

  record(currentState) {
    this.undoStack.push(currentState);
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  undo(currentState) {
    if (this.undoStack.length === 0) return null;
    const prev = this.undoStack.pop();
    this.redoStack.push(currentState);
    if (this.redoStack.length > this.maxDepth) {
      this.redoStack.shift();
    }
    return prev;
  }

  redo(currentState) {
    if (this.redoStack.length === 0) return null;
    const next = this.redoStack.pop();
    this.undoStack.push(currentState);
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    return next;
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}

export function computeFilteredElevation(ele) {
  if (!Array.isArray(ele) || ele.length < 2) return { ascentM: 0, descentM: 0 };
  let ascentM = 0;
  let ehb = 0;
  const ELEVATION_FILTER_M = -5;
  for (let i = 1; i < ele.length; i++) {
    const dh = ele[i] - ele[i - 1];
    ehb += dh;
    if (ehb > 0) {
      ascentM += ehb;
      ehb = 0;
    } else if (ehb < ELEVATION_FILTER_M) {
      ehb = ELEVATION_FILTER_M;
    }
  }
  const netM = ele[ele.length - 1] - ele[0];
  const descentM = Math.max(0, ascentM - netM);
  return { ascentM, descentM };
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function routeToGpx(geojson, trackName) {
  const feat = geojson?.features?.[0];
  if (!feat || !feat.geometry) {
    return '';
  }

  const props = feat.properties || {};
  const lengthM = Number(props['track-length']) || 0;
  const distKm = (lengthM / 1000).toFixed(2);
  const timeMin = Math.round((Number(props['total-time']) || 0) / 60);
  const ascendM = Math.round(Number(props['filtered ascend']) || 0);

  const coords = feat.geometry.coordinates || [];
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

const EARTH_RADIUS_M = 6_371_000;

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function buildProfile(coords) {
  const dist = [0];
  const ele = [coords[0]?.[2] ?? 0];
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1];
    const curr = coords[i];
    const d = haversine(prev[1], prev[0], curr[1], curr[0]);
    dist.push(dist[i - 1] + d);
    ele.push(curr[2] ?? ele[i - 1]);
  }
  return { dist, ele, coords };
}

function nearestIndex(dist, target) {
  let lo = 0;
  let hi = dist.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(dist[lo - 1] - target) < Math.abs(dist[lo] - target)) {
    return lo - 1;
  }
  return lo;
}

function gradeAt(dist, ele, idx, halfWindowM = 40) {
  const center = dist[idx];
  const i0 = nearestIndex(dist, Math.max(0, center - halfWindowM));
  const i1 = nearestIndex(
    dist,
    Math.min(dist[dist.length - 1], center + halfWindowM),
  );
  const run = dist[i1] - dist[i0];
  if (run < 1) return 0;
  return ((ele[i1] - ele[i0]) / run) * 100;
}

function gradeColor(gradePct) {
  if (gradePct <= -3) return '#0ea5e9';
  if (gradePct < 2) return '#22c55e';
  if (gradePct < 5) return '#eab308';
  if (gradePct < 8) return '#f97316';
  return '#ef4444';
}

export function buildElevationChartModel(routeGeoJson, units, slotIdx, compact) {
  const feat = routeGeoJson?.features?.[0];
  const coords = feat?.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;

  const profile = buildProfile(coords);
  const { dist, ele } = profile;
  const hasValidElevation =
    ele.length > 0 && !ele.some((e) => e === undefined || Number.isNaN(e));
  if (!hasValidElevation) return null;

  const totalDist = dist[dist.length - 1] || 0;
  if (totalDist <= 0) return null;

  const props = feat?.properties || {};
  const segments = props.segments || [];

  let minEle = Infinity;
  let maxEle = -Infinity;
  for (let i = 0; i < ele.length; i++) {
    if (ele[i] < minEle) minEle = ele[i];
    if (ele[i] > maxEle) maxEle = ele[i];
  }
  const yMin = minEle;
  const yRange = Math.max(maxEle - minEle, 20);

  const W = 600;
  const H = compact ? 74 : 96;
  const padL = 42;
  const padR = 10;
  const padT = compact ? 5 : 7;
  const padB = compact ? 15 : 17;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xOf = (d) => padL + (d / totalDist) * plotW;
  const yOf = (e) => padT + plotH - ((e - yMin) / yRange) * plotH;

  const specJson = JSON.stringify({
    coords,
    slotIdx,
    compact,
    units,
    hoverDist: -1,
  });

  return {
    specJson,
    profile,
    segments,
    totalDist,
    W,
    H,
    padL,
    padR,
    padT,
    padB,
    plotW,
    plotH,
    yMin,
    yRange,
    xOf,
    yOf,
  };
}

export function computeHoverReadout(model, frac, units = 'metric') {
  const clamped = Math.max(0, Math.min(1, frac));
  const targetDist = clamped * model.totalDist;
  const { dist, ele, coords } = model.profile;
  const idx = nearestIndex(dist, targetDist);
  const d = dist[idx];
  const e = ele[idx];
  const ptCoord = coords[idx];
  const grade = gradeAt(dist, ele, idx);
  const gColor = gradeColor(grade);
  const sign = grade >= 0 ? '+' : '';

  let targetSeg = null;
  if (model.segments.length > 0) {
    targetSeg = model.segments[model.segments.length - 1];
    for (const seg of model.segments) {
      if (d >= seg.from && d <= seg.to) {
        targetSeg = seg;
        break;
      }
    }
  }

  const sCat = targetSeg ? classifySurface(targetSeg.surface, targetSeg.highway) : null;
  const rCat = targetSeg ? classifyRoad(targetSeg.highway) : null;
  const tCat = targetSeg ? classifyTraffic(targetSeg.traffic, targetSeg.highway) : null;
  const nCat = targetSeg ? classifyNoise(targetSeg.noise) : null;
  const spCat = targetSeg ? classifySpeedLimit(targetSeg.maxspeed, targetSeg.highway) : null;
  const rawSurf = targetSeg?.surface ? ` (${targetSeg.surface})` : '';

  return {
    pt: { lon: ptCoord[0], lat: ptCoord[1], ele: e, dist: d, grade },
    cx: model.xOf(d),
    cy: model.yOf(e),
    gradeColor: gColor,
    fields: {
      hide_readout: 'false',
      hover_ele: formatElevation(e, units),
      hover_grade: `${sign}${grade.toFixed(1)}%`,
      hover_grade_style: `background-color: ${gColor}`,
      hover_dist: formatDistance(d, units),
      hide_hover_surf: sCat ? 'false' : 'true',
      hover_surf_dot_style: sCat ? `background-color: ${SURFACE_META[sCat].color}` : '',
      hover_surf_label: sCat ? `${SURFACE_META[sCat].label}${rawSurf}` : '',
      hide_hover_road: rCat ? 'false' : 'true',
      hover_road_dot_style: rCat ? `background-color: ${ROAD_META[rCat].color}` : '',
      hover_road_label: rCat ? ROAD_META[rCat].label : '',
      hide_hover_traffic: tCat ? 'false' : 'true',
      hover_traffic_dot_style: tCat ? `background-color: ${TRAFFIC_META[tCat].color}` : '',
      hover_traffic_label: tCat ? `Traffic: ${TRAFFIC_META[tCat].label}` : '',
      hide_hover_noise: nCat ? 'false' : 'true',
      hover_noise_label: nCat ? `Noise: ${NOISE_META[nCat].label}` : '',
      hide_hover_speed: spCat ? 'false' : 'true',
      hover_speed_label: spCat ? SPEED_LIMIT_META[spCat].label : '',
    },
  };
}

function sliceCoordsForSpan(profile, from, to) {
  if (profile.coords.length < 2) return [];
  let i0 = nearestIndex(profile.dist, from);
  let i1 = nearestIndex(profile.dist, to);
  if (i1 <= i0) {
    if (i0 < profile.coords.length - 1) {
      i1 = i0 + 1;
    } else {
      i0 = Math.max(0, profile.coords.length - 2);
      i1 = profile.coords.length - 1;
    }
  }
  return profile.coords.slice(i0, i1 + 1).map((pt) => [pt[0], pt[1]]);
}

export function buildSurfaceBreakdownModel(routeGeoJson, units, activeHighlight) {
  const feat = routeGeoJson?.features?.[0];
  const coords = feat?.geometry?.coordinates;
  const props = feat?.properties || {};
  const rawSegments = props.segments || [];

  if (!coords || coords.length < 2 || rawSegments.length === 0) {
    return { specJson: '', rows: [] };
  }

  const profile = buildProfile(coords);
  const totalDist = profile.dist[profile.dist.length - 1] || 0;
  if (totalDist <= 0) {
    return { specJson: '', rows: [] };
  }

  const buildRow = (title, classifier, meta) => {
    const totals = new Map();
    const merged = [];

    for (const s of rawSegments) {
      const len = Math.max(0, s.to - s.from);
      if (len <= 0) continue;
      const cat = classifier(s);
      const info = meta[cat];
      if (!info) continue;

      const prevTotal = totals.get(info.label);
      totals.set(info.label, { color: info.color, dist: (prevTotal?.dist || 0) + len });

      const last = merged[merged.length - 1];
      if (last && last.label === info.label) {
        last.to = s.to;
      } else {
        merged.push({ label: info.label, color: info.color, from: s.from, to: s.to });
      }
    }

    if (merged.length === 0) return null;

    const segments = merged.map((m) => ({
      label: m.label,
      color: m.color,
      dist: Math.max(0, m.to - m.from),
      coords: sliceCoordsForSpan(profile, m.from, m.to),
    }));

    const items = Object.keys(meta)
      .map((cat) => {
        const info = meta[cat];
        const entry = totals.get(info.label);
        return entry ? [info.label, entry] : null;
      })
      .filter((x) => x !== null && x[1].dist > 0);

    const totalBarDist = segments.reduce((acc, s) => acc + s.dist, 0) || totalDist;
    return { title, items, segments, totalBarDist };
  };

  const rows = [
    buildRow('Surface', (s) => classifySurface(s.surface, s.highway), SURFACE_META),
    buildRow('Road Type', (s) => classifyRoad(s.highway), ROAD_META),
    buildRow('Traffic', (s) => classifyTraffic(s.traffic, s.highway), TRAFFIC_META),
    buildRow('Noise & pollution', (s) => classifyNoise(s.noise), NOISE_META),
    buildRow('Speed Limit', (s) => classifySpeedLimit(s.maxspeed, s.highway), SPEED_LIMIT_META),
  ].filter((r) => r !== null);

  if (rows.length === 0) {
    return { specJson: '', rows: [] };
  }

  return {
    specJson: JSON.stringify({
      segments: rawSegments,
      units,
      activeHighlight,
    }),
    rows,
  };
}
