// The panel under the map with route numbers, route alternatives, elevation, and stacked profile bars.

import { formatDistance, formatDuration, formatElevation, onUnitsChange } from './format.ts';

export interface SegmentHighlight {
  coordinates: number[][][];
  color: string;
}

export interface Hooks {
  /** Called with the position under the chart pointer, or null when the pointer leaves. */
  onHover: (position: { lon: number; lat: number } | null) => void;
  /** Called when hovering a segment in the bottom bars or a category in the legend. */
  onHighlightSegment?: (highlight: SegmentHighlight | null) => void;
  /** Called when the user picks another route alternative (0 to 3). */
  onAlternative: (index: number) => void;
}

export type SurfaceCategory = 'paved' | 'unpaved' | 'gravel' | 'trail' | 'cobblestone' | 'unknown';

export const SURFACE_META: Record<SurfaceCategory, { label: string; color: string }> = {
  paved: { label: 'Paved', color: '#10b981' },
  gravel: { label: 'Gravel', color: '#f59e0b' },
  unpaved: { label: 'Unpaved', color: '#d97706' },
  trail: { label: 'Trail', color: '#854d0e' },
  cobblestone: { label: 'Cobblestone', color: '#8b5cf6' },
  unknown: { label: 'Unknown', color: '#94a3b8' },
};

export function classifySurface(surface?: string, highway?: string): SurfaceCategory {
  const s = (surface || '').toLowerCase().trim();
  const h = (highway || '').toLowerCase().trim();

  // 1. Explicit surface tags
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

  // 2. Inferred from highway when surface tag is absent
  if (['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'living_street', 'service', 'cycleway', 'pedestrian'].includes(h)) {
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

export type RoadCategory = 'cycleway' | 'quiet' | 'minor' | 'major' | 'path' | 'unknown';

export const ROAD_META: Record<RoadCategory, { label: string; color: string }> = {
  cycleway: { label: 'Cycleway', color: '#06b6d4' },
  quiet: { label: 'Quiet street', color: '#10b981' },
  minor: { label: 'Minor road', color: '#f59e0b' },
  major: { label: 'Major road', color: '#ef4444' },
  path: { label: 'Path / Trail', color: '#854d0e' },
  unknown: { label: 'Unknown', color: '#94a3b8' },
};

export function classifyRoad(highway?: string): RoadCategory {
  const h = (highway || '').toLowerCase().trim();
  if (h === 'cycleway') return 'cycleway';
  if (['residential', 'living_street', 'service', 'unclassified', 'pedestrian'].includes(h)) return 'quiet';
  if (['tertiary', 'tertiary_link'].includes(h)) return 'minor';
  if (['secondary', 'secondary_link', 'primary', 'primary_link', 'trunk', 'trunk_link', 'motorway', 'motorway_link'].includes(h)) return 'major';
  if (['path', 'footway', 'bridleway', 'track', 'steps'].includes(h)) return 'path';
  return 'unknown';
}

export type TrafficCategory = 'traffic_free' | 'low' | 'acceptable' | 'heavy';

export const TRAFFIC_META: Record<TrafficCategory, { label: string; color: string }> = {
  traffic_free: { label: 'Traffic-free', color: '#059669' },
  low: { label: 'Low', color: '#84cc16' },
  acceptable: { label: 'Acceptable', color: '#f59e0b' },
  heavy: { label: 'Heavy', color: '#ef4444' },
};

export function classifyTraffic(traffic?: number, highway?: string): TrafficCategory {
  const h = (highway || '').toLowerCase().trim();
  if (['cycleway', 'path', 'footway', 'pedestrian', 'bridleway', 'track', 'steps'].includes(h)) {
    return 'traffic_free';
  }
  const t = traffic || 0;
  if (t >= 4) return 'heavy';
  if (t >= 2) return 'acceptable';
  return 'low';
}

export type NoiseCategory = 'very_quiet' | 'moderate' | 'loud';

export const NOISE_META: Record<NoiseCategory, { label: string; color: string }> = {
  very_quiet: { label: 'Very quiet', color: '#10b981' },
  moderate: { label: 'Moderate', color: '#f59e0b' },
  loud: { label: 'Loud', color: '#ef4444' },
};

export function classifyNoise(noise?: number): NoiseCategory {
  const n = noise || 0;
  if (n >= 4) return 'loud';
  if (n >= 2) return 'moderate';
  return 'very_quiet';
}

function gradeColor(grade: number): string {
  if (grade < -1) return '#38bdf8'; // light blue: downhill
  if (grade <= 3) return '#22c55e'; // green: flat / mild
  if (grade <= 6) return '#eab308'; // yellow: gentle climb
  if (grade <= 9) return '#f97316'; // orange: moderate climb
  return '#ef4444'; // red: steep climb
}

interface SegmentData {
  from: number;
  to: number;
  surface: string;
  highway: string;
  noise?: number;
  traffic?: number;
}

const panel = document.getElementById('route-info') as HTMLDivElement;
const distanceEl = document.getElementById('ri-distance') as HTMLSpanElement;
const timeEl = document.getElementById('ri-time') as HTMLSpanElement;
const ascentEl = document.getElementById('ri-ascent') as HTMLSpanElement;
const descentEl = document.getElementById('ri-descent') as HTMLSpanElement;
const altsEl = document.getElementById('ri-alternatives') as HTMLDivElement;
const btnToggleRiCollapse = document.getElementById('btn-toggle-ri-collapse') as HTMLButtonElement | null;
const elevationDetailsEl = document.getElementById('elevation-details') as HTMLDetailsElement | null;
const surfaceDetailsEl = document.getElementById('surface-details') as HTMLDetailsElement | null;
const chartEl = document.getElementById('elevation-chart') as HTMLDivElement;
const surfaceSectionEl = document.getElementById('surface-section') as HTMLDivElement;
const surfaceBarEl = document.getElementById('surface-bar') as HTMLDivElement;
const surfaceLegendEl = document.getElementById('surface-legend') as HTMLDivElement;
const roadBarEl = document.getElementById('road-bar') as HTMLDivElement;
const roadLegendEl = document.getElementById('road-legend') as HTMLDivElement;
const trafficBarEl = document.getElementById('traffic-bar') as HTMLDivElement;
const trafficLegendEl = document.getElementById('traffic-legend') as HTMLDivElement;
const noiseBarEl = document.getElementById('noise-bar') as HTMLDivElement;
const noiseLegendEl = document.getElementById('noise-legend') as HTMLDivElement;

const CHART_HEIGHT = 96;
const CHART_PAD = { top: 8, bottom: 16, left: 4, right: 4 };
// The grade shown on hover is measured over this distance on each side of the pointer.
const GRADE_WINDOW_M = 40;
const SVG_NS = 'http://www.w3.org/2000/svg';

let hooks: Hooks;
let route: GeoJSON.FeatureCollection | null = null;
let alternative = 0;
let routeSegments: SegmentData[] = [];

export interface Profile {
  /** Distance from the start in metres, per vertex. */
  dist: number[];
  /** Elevation in metres, per vertex. */
  ele: number[];
  coords: number[][];
}

let compareProfile: Profile | null = null;

export function setCompareProfile(p: Profile | null) {
  compareProfile = p;
  if (route) {
    drawChart();
  }
}

function haversine(a: number[], b: number[]): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function buildProfile(coords: number[][]): Profile {
  const dist = [0];
  for (let i = 1; i < coords.length; i++) {
    dist.push(dist[i - 1] + haversine(coords[i - 1], coords[i]));
  }
  const ele = coords.map((c) => c[2]);

  // Frontend elevation smoothing for water crossings:
  // Raster DEM datasets, like SRTM, lack bridge deck elevations and treat water
  // bodies or missing cells as 0 m. Bridges crossing tidal rivers, such as the
  // Thames in London, drop abruptly to 0 m in the raw profile.
  //
  // Here we linearly interpolate intermediate runs of 0 m between valid non-zero
  // endpoints along the route.
  //
  // Caveats:
  // 1. Only fixes structures dropping to 0 m. Inland bridges over valleys (which
  //    drop to non-zero ground level) and tunnels (which spike upwards) remain unaffected.
  // 2. Coastal roads sitting at sea level (0 m) between higher points will be
  //    interpolated into an artificial ramp.
  // 3. This is visual-only smoothing for the elevation chart. Core router metrics
  //    like filtered ascend, travel time, and energy still reflect raw DEM heights.
  let i = 0;
  while (i < ele.length) {
    if (ele[i] === 0) {
      let j = i;
      while (j < ele.length && ele[j] === 0) j++;

      const hasLeft = i > 0;
      const hasRight = j < ele.length;

      if (hasLeft && hasRight) {
        const leftEle = ele[i - 1];
        const rightEle = ele[j];
        const leftDist = dist[i - 1];
        const rightDist = dist[j];
        const span = rightDist - leftDist;
        if (span > 0) {
          for (let k = i; k < j; k++) {
            const t = (dist[k] - leftDist) / span;
            ele[k] = leftEle + t * (rightEle - leftEle);
          }
        }
      } else if (hasLeft) {
        for (let k = i; k < j; k++) {
          ele[k] = ele[i - 1];
        }
      } else if (hasRight) {
        for (let k = i; k < j; k++) {
          ele[k] = ele[j];
        }
      }
      i = j;
    } else {
      i++;
    }
  }

  return { dist, ele, coords };
}


let profile: Profile | null = null;

function attributesAt(d: number): {
  surfLabel: string;
  surfDetail: string;
  roadLabel: string;
  trafficLabel: string;
  noiseLabel: string;
} {
  if (!routeSegments || routeSegments.length === 0) {
    return { surfLabel: '', surfDetail: '', roadLabel: '', trafficLabel: '', noiseLabel: '' };
  }
  let target = routeSegments[routeSegments.length - 1];
  for (const seg of routeSegments) {
    if (d >= seg.from && d <= seg.to) {
      target = seg;
      break;
    }
  }
  const sCat = classifySurface(target.surface, target.highway);
  const rCat = classifyRoad(target.highway);
  const tCat = classifyTraffic(target.traffic, target.highway);
  const nCat = classifyNoise(target.noise);
  const trafficClassStr = target.traffic ? ` (class ${target.traffic})` : '';
  const noiseClassStr = target.noise ? ` (class ${target.noise})` : '';
  return {
    surfLabel: SURFACE_META[sCat].label,
    surfDetail: target.surface || target.highway,
    roadLabel: ROAD_META[rCat].label,
    trafficLabel: `${TRAFFIC_META[tCat].label}${trafficClassStr}`,
    noiseLabel: `${NOISE_META[nCat].label}${noiseClassStr}`,
  };
}

function render() {
  if (!route) return;
  const feat = route.features[0];
  const props = (feat.properties || {}) as Record<string, any>;
  const coords = (feat.geometry as GeoJSON.LineString).coordinates;
  profile = buildProfile(coords);
  routeSegments = props.segments || [];

  const ascent = Number(props['filtered ascend']);
  // Descent follows from the ascent and the net height change.
  const net = profile.ele[profile.ele.length - 1] - profile.ele[0];
  distanceEl.textContent = formatDistance(Number(props['track-length']));
  timeEl.textContent = formatDuration(Number(props['total-time']));
  ascentEl.textContent = formatElevation(ascent);
  descentEl.textContent = formatElevation(Math.max(0, ascent - net));

  altsEl.querySelectorAll('button').forEach((b) => {
    const active = Number(b.dataset.alt) === alternative;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  drawChart();
  drawBars();
}

function svgEl<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function drawChart() {
  chartEl.replaceChildren();
  if (!profile || profile.ele.some((e) => e === undefined || Number.isNaN(e))) {
    chartEl.textContent = 'No elevation data for this route.';
    return;
  }
  const { dist, ele } = profile;
  const cmpDist = compareProfile?.dist;
  const cmpEle = compareProfile?.ele;
  const hasCmp = !!(cmpDist && cmpEle && cmpDist.length > 1 && cmpEle.length > 1);

  const containerW = chartEl.clientWidth || (panel.clientWidth ? panel.clientWidth - 28 : 0);
  const width = Math.max(240, containerW);
  const total = Math.max(dist[dist.length - 1] || 1, hasCmp ? cmpDist[cmpDist.length - 1] : 0);
  let minEle = Math.min(...ele);
  let maxEle = Math.max(...ele);
  if (hasCmp && cmpEle.length > 0) {
    minEle = Math.min(minEle, Math.min(...cmpEle));
    maxEle = Math.max(maxEle, Math.max(...cmpEle));
  }
  // Keep a small flat route from looking like a mountain.
  const span = Math.max(maxEle - minEle, 20);
  const plotW = width - CHART_PAD.left - CHART_PAD.right;
  const plotH = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom;
  const x = (d: number) => CHART_PAD.left + (d / total) * plotW;
  const y = (e: number) => CHART_PAD.top + plotH - ((e - minEle) / span) * plotH;

  const line = dist.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(d).toFixed(1)},${y(ele[i]).toFixed(1)}`).join(' ');
  const area = `${line} L${x(dist[dist.length - 1] || total).toFixed(1)},${CHART_PAD.top + plotH} L${x(0).toFixed(1)},${CHART_PAD.top + plotH} Z`;

  const svg = svgEl('svg', { width, height: CHART_HEIGHT, viewBox: `0 0 ${width} ${CHART_HEIGHT}`, role: 'img' });
  svg.setAttribute('aria-label', 'Elevation along the route');

  // Linear gradient for grade coloring
  const defs = svgEl('defs', {});
  const grad = svgEl('linearGradient', {
    id: 'ec-grade-grad',
    gradientUnits: 'userSpaceOnUse',
    x1: CHART_PAD.left,
    y1: 0,
    x2: CHART_PAD.left + plotW,
    y2: 0,
  });

  for (let i = 0; i < dist.length; i++) {
    const pct = Math.max(0, Math.min(100, (dist[i] / total) * 100));
    const stop = svgEl('stop', {
      offset: `${pct.toFixed(2)}%`,
      'stop-color': gradeColor(gradeAt(i)),
    });
    grad.append(stop);
  }
  defs.append(grad);
  svg.append(defs);

  svg.append(svgEl('path', { d: area, class: 'ec-area' }), svgEl('path', { d: line, class: 'ec-line', stroke: 'url(#ec-grade-grad)' }));

  if (hasCmp) {
    const cmpLine = cmpDist.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(d).toFixed(1)},${y(cmpEle[i]).toFixed(1)}`).join(' ');
    svg.append(svgEl('path', { d: cmpLine, class: 'ec-line-compare' }));

    const cmpLegend = svgEl('text', {
      x: width - CHART_PAD.right,
      y: CHART_PAD.top + 9,
      class: 'ec-label',
      'text-anchor': 'end',
    });
    cmpLegend.innerHTML = '<tspan fill="#3b82f6">― Router</tspan>  <tspan fill="#d946ef">╌ GPX</tspan>';
    svg.append(cmpLegend);
  }

  const labels: Array<[string, number, number, string]> = [
    [formatElevation(maxEle), CHART_PAD.left + 2, CHART_PAD.top + 9, 'start'],
    [formatElevation(minEle), CHART_PAD.left + 2, CHART_PAD.top + plotH - 3, 'start'],
    [formatDistance(0), CHART_PAD.left, CHART_HEIGHT - 3, 'start'],
    [formatDistance(total), hasCmp ? width - CHART_PAD.right - 90 : width - CHART_PAD.right, CHART_HEIGHT - 3, 'end'],
  ];
  for (const [text, lx, ly, anchor] of labels) {
    const t = svgEl('text', { x: lx, y: ly, class: 'ec-label', 'text-anchor': anchor });
    t.textContent = text;
    svg.append(t);
  }

  const cursor = svgEl('line', { class: 'ec-cursor', y1: CHART_PAD.top, y2: CHART_PAD.top + plotH, visibility: 'hidden' });
  const tip = svgEl('text', { class: 'ec-tip', y: CHART_PAD.top + 9, visibility: 'hidden' });
  svg.append(cursor, tip);

  const hide = () => {
    cursor.setAttribute('visibility', 'hidden');
    tip.setAttribute('visibility', 'hidden');
    hooks.onHover(null);
  };
  svg.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const d = Math.min(total, Math.max(0, ((e.clientX - box.left - CHART_PAD.left) / plotW) * total));
    const i = nearestIndex(dist, Math.min(dist[dist.length - 1], d));
    const cx = x(dist[i]);
    cursor.setAttribute('x1', String(cx));
    cursor.setAttribute('x2', String(cx));
    cursor.setAttribute('visibility', 'visible');
    const grade = gradeAt(i);
    const attrs = attributesAt(dist[i]);
    const surfStr = attrs.surfLabel ? `  •  ${attrs.surfDetail ? `${attrs.surfLabel} (${attrs.surfDetail})` : attrs.surfLabel}` : '';
    const roadStr = attrs.roadLabel ? `  •  ${attrs.roadLabel}` : '';
    const trafficStr = attrs.trafficLabel ? `  •  Traffic: ${attrs.trafficLabel}` : '';
    const noiseStr = attrs.noiseLabel ? `  •  Noise: ${attrs.noiseLabel}` : '';
    let cmpStr = '';
    if (hasCmp) {
      const cmpI = nearestIndex(cmpDist, Math.min(cmpDist[cmpDist.length - 1], d));
      cmpStr = `  •  GPX: ${formatElevation(cmpEle[cmpI])}`;
    }
    tip.textContent = `${formatElevation(ele[i])}  ${grade >= 0 ? '+' : ''}${grade.toFixed(1)}%  ${formatDistance(dist[i])}${cmpStr}${surfStr}${roadStr}${trafficStr}${noiseStr}`;
    // Keep the label inside the chart: flip to the left of the cursor near the right edge.
    const flip = cx > width * 0.6;
    tip.setAttribute('x', String(flip ? cx - 6 : cx + 6));
    tip.setAttribute('text-anchor', flip ? 'end' : 'start');
    tip.setAttribute('visibility', 'visible');
    hooks.onHover({ lon: profile!.coords[i][0], lat: profile!.coords[i][1] });
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('pointercancel', hide);
  chartEl.append(svg);
}

function segmentCoordinates(fromM: number, toM: number): number[][] {
  if (!profile || profile.coords.length < 2) return [];
  let i0 = nearestIndex(profile.dist, fromM);
  let i1 = nearestIndex(profile.dist, toM);
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

function renderStackedBar<T extends string>(
  barEl: HTMLElement,
  legendEl: HTMLElement,
  totalDist: number,
  classifier: (seg: SegmentData) => T,
  meta: Record<T, { label: string; color: string }>
) {
  barEl.replaceChildren();
  legendEl.replaceChildren();

  const categoryTotals: Partial<Record<T, number>> = {};

  interface MergedBarSeg {
    from: number;
    to: number;
    category: T;
  }
  const merged: MergedBarSeg[] = [];

  for (const s of routeSegments) {
    const len = Math.max(0, s.to - s.from);
    if (len === 0) continue;
    const cat = classifier(s);
    categoryTotals[cat] = (categoryTotals[cat] || 0) + len;

    if (merged.length > 0 && merged[merged.length - 1].category === cat) {
      merged[merged.length - 1].to = s.to;
    } else {
      merged.push({ from: s.from, to: s.to, category: cat });
    }
  }

  for (const seg of merged) {
    const widthPct = Math.max(0.1, ((seg.to - seg.from) / totalDist) * 100);
    const div = document.createElement('div');
    div.className = 'surface-segment';
    div.style.width = `${widthPct.toFixed(2)}%`;
    div.style.backgroundColor = meta[seg.category].color;
    div.title = `${meta[seg.category].label}: ${formatDistance(seg.to - seg.from)}`;

    const highlightSeg = () => {
      const coords = segmentCoordinates(seg.from, seg.to);
      if (coords.length >= 2 && hooks.onHighlightSegment) {
        hooks.onHighlightSegment({
          coordinates: [coords],
          color: meta[seg.category].color,
        });
      }
    };
    div.addEventListener('pointerenter', highlightSeg);
    div.addEventListener('pointermove', highlightSeg);

    barEl.append(div);
  }

  const cats = (Object.keys(meta) as T[])
    .filter((cat) => (categoryTotals[cat] || 0) > 0);

  for (const cat of cats) {
    const dist = categoryTotals[cat] || 0;
    const pct = Math.round((dist / totalDist) * 100);
    if (pct < 1 && dist < 100) continue;

    const item = document.createElement('span');
    item.className = 'surface-legend-item';

    const swatch = document.createElement('span');
    swatch.className = 'surface-swatch';
    swatch.style.backgroundColor = meta[cat].color;

    const label = document.createElement('span');
    label.textContent = `${meta[cat].label} ${pct}%`;

    item.append(swatch, label);

    item.addEventListener('pointerenter', () => {
      const allCoords: number[][][] = [];
      for (const s of merged) {
        if (s.category === cat) {
          const c = segmentCoordinates(s.from, s.to);
          if (c.length >= 2) allCoords.push(c);
        }
      }
      if (allCoords.length > 0 && hooks.onHighlightSegment) {
        hooks.onHighlightSegment({
          coordinates: allCoords,
          color: meta[cat].color,
        });
      }
    });
    item.addEventListener('pointerleave', () => {
      hooks.onHighlightSegment?.(null);
    });

    legendEl.append(item);
  }
}

function drawBars() {
  if (!surfaceSectionEl) return;

  if (!profile || routeSegments.length === 0) {
    surfaceSectionEl.hidden = true;
    if (surfaceDetailsEl) surfaceDetailsEl.hidden = true;
    return;
  }
  surfaceSectionEl.hidden = false;
  if (surfaceDetailsEl) surfaceDetailsEl.hidden = false;

  const total = profile.dist[profile.dist.length - 1] || 1;

  if (surfaceBarEl && surfaceLegendEl) {
    renderStackedBar(
      surfaceBarEl,
      surfaceLegendEl,
      total,
      (s) => classifySurface(s.surface, s.highway),
      SURFACE_META
    );
  }

  if (roadBarEl && roadLegendEl) {
    renderStackedBar(
      roadBarEl,
      roadLegendEl,
      total,
      (s) => classifyRoad(s.highway),
      ROAD_META
    );
  }

  if (trafficBarEl && trafficLegendEl) {
    renderStackedBar(
      trafficBarEl,
      trafficLegendEl,
      total,
      (s) => classifyTraffic(s.traffic, s.highway),
      TRAFFIC_META
    );
  }

  if (noiseBarEl && noiseLegendEl) {
    renderStackedBar(
      noiseBarEl,
      noiseLegendEl,
      total,
      (s) => classifyNoise(s.noise),
      NOISE_META
    );
  }
}

/** Index of the vertex closest to distance `d`. `dist` is sorted. */
function nearestIndex(dist: number[], d: number): number {
  let lo = 0;
  let hi = dist.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] < d) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && d - dist[lo - 1] < dist[lo] - d ? lo - 1 : lo;
}

/** Grade in percent around vertex `i`. */
function gradeAt(i: number): number {
  const { dist, ele } = profile!;
  const a = nearestIndex(dist, dist[i] - GRADE_WINDOW_M);
  const b = nearestIndex(dist, dist[i] + GRADE_WINDOW_M);
  const run = dist[b] - dist[a];
  return run > 0 ? ((ele[b] - ele[a]) / run) * 100 : 0;
}

function isMobile(): boolean {
  return window.matchMedia('(max-width: 640px)').matches;
}

let userManuallyExpanded = false;

export function setRouteInfoCollapsed(collapsed: boolean) {
  panel.classList.toggle('collapsed', collapsed);
  if (btnToggleRiCollapse) {
    btnToggleRiCollapse.setAttribute('aria-expanded', String(!collapsed));
    btnToggleRiCollapse.title = collapsed ? 'Expand details' : 'Collapse details';
    btnToggleRiCollapse.setAttribute('aria-label', btnToggleRiCollapse.title);
  }
  if (collapsed) {
    hooks?.onHover(null);
    hooks?.onHighlightSegment?.(null);
  }
}

/** Shows the panel for a route. `index` is the alternative the route belongs to. */
export function showRouteInfo(geojson: GeoJSON.FeatureCollection, index: number) {
  const isFirstShow = panel.hidden;
  route = geojson;
  alternative = index;
  panel.hidden = false;
  if (isMobile() && (isFirstShow || !userManuallyExpanded)) {
    setRouteInfoCollapsed(true);
  } else if (!isMobile() && isFirstShow) {
    setRouteInfoCollapsed(false);
  }
  render();
}

export function hideRouteInfo() {
  route = null;
  profile = null;
  routeSegments = [];
  panel.hidden = true;
  userManuallyExpanded = false;
  if (isMobile()) {
    setRouteInfoCollapsed(true);
  }
  hooks.onHover(null);
  hooks.onHighlightSegment?.(null);
}

function setupBarHover(bar: HTMLElement | null) {
  if (!bar) return;
  bar.addEventListener('pointermove', (e) => {
    if (!profile) return;
    const box = bar.getBoundingClientRect();
    const total = profile.dist[profile.dist.length - 1] || 1;
    const d = Math.min(total, Math.max(0, ((e.clientX - box.left) / box.width) * total));
    const i = nearestIndex(profile.dist, d);
    hooks.onHover({ lon: profile.coords[i][0], lat: profile.coords[i][1] });
  });
  bar.addEventListener('pointerleave', () => {
    hooks.onHover(null);
    hooks.onHighlightSegment?.(null);
  });
}

export function initRouteInfo(h: Hooks) {
  hooks = h;
  if (isMobile()) {
    setRouteInfoCollapsed(true);
  } else {
    setRouteInfoCollapsed(false);
  }

  altsEl.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-alt]');
    if (button) hooks.onAlternative(Number(button.dataset.alt));
  });

  if (btnToggleRiCollapse) {
    btnToggleRiCollapse.addEventListener('click', () => {
      const isCollapsed = panel.classList.toggle('collapsed');
      userManuallyExpanded = !isCollapsed;
      btnToggleRiCollapse.setAttribute('aria-expanded', String(!isCollapsed));
      btnToggleRiCollapse.title = isCollapsed ? 'Expand details' : 'Collapse details';
      btnToggleRiCollapse.setAttribute('aria-label', btnToggleRiCollapse.title);
      if (isCollapsed) {
        hooks.onHover(null);
        hooks.onHighlightSegment?.(null);
      } else if (route) {
        requestAnimationFrame(() => {
          if (!elevationDetailsEl || elevationDetailsEl.open) drawChart();
          if (!surfaceDetailsEl || surfaceDetailsEl.open) drawBars();
        });
      }
    });
  }

  if (elevationDetailsEl) {
    elevationDetailsEl.addEventListener('toggle', () => {
      if (elevationDetailsEl.open && route) {
        drawChart();
      } else {
        hooks.onHover(null);
      }
    });
  }

  if (surfaceDetailsEl) {
    surfaceDetailsEl.addEventListener('toggle', () => {
      if (surfaceDetailsEl.open && route) {
        drawBars();
      } else {
        hooks.onHover(null);
        hooks.onHighlightSegment?.(null);
      }
    });
  }

  setupBarHover(surfaceBarEl);
  setupBarHover(roadBarEl);
  setupBarHover(trafficBarEl);
  setupBarHover(noiseBarEl);

  onUnitsChange(render);
  // The chart is drawn at the panel's width, so it has to follow window size changes.
  window.addEventListener('resize', () => {
    if (route) {
      if (!elevationDetailsEl || elevationDetailsEl.open) drawChart();
      if (!surfaceDetailsEl || surfaceDetailsEl.open) drawBars();
    }
  });
}
