// BRouter Wasm Worker runtime (appended after embedded assets and wasm-bindgen glue).

const DB_NAME = "gabi-router-offline";
const DB_VERSION = 1;
const WORKER_ORIGIN =
  typeof self !== "undefined" && self.location?.origin && self.location.origin !== "null"
    ? self.location.origin
    : "";
const IS_SURITA_ORIGIN = WORKER_ORIGIN === "https://router.surita.dev";
const SEGMENT_BASE_URL = IS_SURITA_ORIGIN
  ? "https://tiles.surita.dev/segments4"
  : `${WORKER_ORIGIN}/shell/units/brouter/segments`;
const PMTILES_BASE_URL = "https://tiles.surita.dev/map-tiles";

const OFFLINE_CATALOG = {
  "sao-paulo": {
    id: "sao-paulo",
    name: "São Paulo Metro",
    segments: ["W50_S25"],
    size_mb: 18.4,
  },
  "london": {
    id: "london",
    name: "Greater London & England",
    segments: ["W5_N50", "E0_N50"],
    size_mb: 24.1,
  },
  "scotland": {
    id: "scotland",
    name: "Scotland & Highlands",
    segments: ["W5_N55", "W5_N60"],
    size_mb: 15.6,
  },
  "ireland": {
    id: "ireland",
    name: "Ireland & West Coast",
    segments: ["W10_N50", "W10_N55", "W15_N50"],
    size_mb: 19.2,
  },
};

const PROFILE_META = {
  "gabis-fast-city": { label: "Gabi's Fast City", speedKmh: 21, hillBias: 0.35, trafficBias: 0.25, unpavedBias: 0.15, detour: 1.06, color: "#2563eb" },
  "gabis-safe-road": { label: "Gabi's Safe Road", speedKmh: 19, hillBias: 0.45, trafficBias: 0.08, unpavedBias: 0.12, detour: 1.14, color: "#16a34a" },
  "gabis-lite-gravel": { label: "Gabi's Lite Gravel", speedKmh: 18, hillBias: 0.50, trafficBias: 0.10, unpavedBias: 0.65, detour: 1.18, color: "#d97706" },
  "fastbike-lowtraffic": { label: "Fastbike Low Traffic", speedKmh: 24, hillBias: 0.30, trafficBias: 0.18, unpavedBias: 0.05, detour: 1.09, color: "#2563eb" },
  "fastbike-verylowtraffic": { label: "Fastbike Very Low Traffic", speedKmh: 22, hillBias: 0.35, trafficBias: 0.06, unpavedBias: 0.08, detour: 1.16, color: "#16a34a" },
  "fastbike": { label: "Fastbike", speedKmh: 27, hillBias: 0.22, trafficBias: 0.55, unpavedBias: 0.02, detour: 1.03, color: "#dc2626" },
  "gravel": { label: "Gravel", speedKmh: 17, hillBias: 0.60, trafficBias: 0.08, unpavedBias: 0.82, detour: 1.22, color: "#d97706" },
  "trekking": { label: "Trekking", speedKmh: 18, hillBias: 0.40, trafficBias: 0.15, unpavedBias: 0.35, detour: 1.12, color: "#0891b2" },
  "mtb": { label: "Mountain Bike", speedKmh: 15, hillBias: 0.75, trafficBias: 0.05, unpavedBias: 0.90, detour: 1.26, color: "#7c3aed" },
  "shortest": { label: "Shortest", speedKmh: 20, hillBias: 0.80, trafficBias: 0.65, unpavedBias: 0.40, detour: 1.01, color: "#475569" },
  "custom": { label: "Custom Profile", speedKmh: 20, hillBias: 0.40, trafficBias: 0.20, unpavedBias: 0.25, detour: 1.10, color: "#9333ea" },
};

const segmentBuffers = new Map();
const installedBundles = new Map();
let routerInstance = null;
let initPromise = null;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gunzipBytes(gzBytes) {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(gzBytes);
  writer.close();
  const res = new Response(ds.readable);
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}

function openOfflineDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("segments")) {
        db.createObjectStore("segments", { keyPath: "name" });
      }
      if (!db.objectStoreNames.contains("bundles")) {
        db.createObjectStore("bundles", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(storeName, key) {
  const db = await openOfflineDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function idbPut(storeName, value) {
  const db = await openOfflineDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function idbDelete(storeName, key) {
  const db = await openOfflineDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function idbGetAllBundles() {
  const map = {};
  for (const [k, v] of installedBundles.entries()) map[k] = v;
  const db = await openOfflineDb();
  if (!db) return map;
  return new Promise((resolve) => {
    const tx = db.transaction("bundles", "readonly");
    const req = tx.objectStore("bundles").getAll();
    req.onsuccess = () => {
      for (const item of req.result || []) map[item.id] = item;
      resolve(map);
    };
    req.onerror = () => resolve(map);
  });
}

async function ensureRouter() {
  if (routerInstance) return routerInstance;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const gzBytes = b64ToBytes(WASM_GZ_B64);
    const wasmBytes = await gunzipBytes(gzBytes);
    await __wbg_init({ module_or_path: wasmBytes });
    const r = new WasmRouter();
    r.load_lookups(LOOKUPS_DAT);
    for (const [name, content] of Object.entries(PROFILES)) {
      r.load_profile(name, content);
    }
    r.set_segment_reader(
      (name) => {
        const buf = segmentBuffers.get(name);
        return buf ? buf.byteLength : 0;
      },
      (name, start, end) => {
        const buf = segmentBuffers.get(name);
        if (!buf) return new Uint8Array(0);
        return buf.subarray(start, end);
      },
    );
    routerInstance = r;
    return r;
  })();
  return initPromise;
}

function segmentNameFor(lon, lat) {
  const lonBase = Math.floor((lon + 180) / 5) * 5 - 180;
  const latBase = Math.floor((lat + 90) / 5) * 5 - 90;
  const lonPrefix = lonBase < 0 ? `W${Math.abs(lonBase)}` : `E${lonBase}`;
  const latPrefix = latBase < 0 ? `S${Math.abs(latBase)}` : `N${latBase}`;
  return `${lonPrefix}_${latPrefix}`;
}

async function ensureSegmentLoaded(segName) {
  if (segmentBuffers.has(segName)) return true;
  if (typeof EMBEDDED_SEGMENTS_GZ_B64 === "object" && EMBEDDED_SEGMENTS_GZ_B64 && EMBEDDED_SEGMENTS_GZ_B64[segName]) {
    const bytes = await gunzipBytes(b64ToBytes(EMBEDDED_SEGMENTS_GZ_B64[segName]));
    if (bytes.byteLength >= 200) {
      segmentBuffers.set(segName, bytes);
      return true;
    }
  }
  const cached = await idbGet("segments", segName);
  if (cached && cached.bytes instanceof Uint8Array && cached.bytes.byteLength > 0) {
    segmentBuffers.set(segName, cached.bytes);
    return true;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${SEGMENT_BASE_URL}/${segName}.rd5`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const ab = await res.arrayBuffer();
    const bytes = new Uint8Array(ab);
    if (bytes.byteLength < 200) return false;
    segmentBuffers.set(segName, bytes);
    await idbPut("segments", { name: segName, bytes, updated_at: Date.now() });
    return true;
  } catch (_) {
    clearTimeout(timer);
    return false;
  }
}

function haversineMeters(lon1, lat1, lon2, lat2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseWayTags(tagsStr) {
  const out = {};
  if (!tagsStr) return out;
  for (const token of String(tagsStr).trim().split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq > 0) out[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return out;
}

function classifyWay(tags) {
  const hw = tags.highway || "unclassified";
  const surf = tags.surface || "";
  const cycleway = tags.cycleway || tags["cycleway:left"] || tags["cycleway:right"] || "";
  const bicycle = tags.bicycle || "";
  const maxspeed = parseInt(tags.maxspeed || "0", 10) || 0;
  const trafficClass = parseInt(tags.estimated_traffic_class || "0", 10) || 0;
  const noiseClass = parseInt(tags.estimated_noise_class || "0", 10) || 0;

  let surfaceCat = "Paved Smooth";
  if (["asphalt", "paved", "concrete", "concrete:plates"].includes(surf)) {
    surfaceCat = "Paved Smooth";
  } else if (["paving_stones", "sett", "cobblestone", "unhewn_cobblestone"].includes(surf)) {
    surfaceCat = "Paved Rough";
  } else if (["compacted", "fine_gravel", "wood", "metal"].includes(surf)) {
    surfaceCat = "Compacted";
  } else if (["gravel", "unpaved", "pebblestone", "dirt", "earth", "ground", "grass", "mud", "sand"].includes(surf) || ["track", "path", "bridleway"].includes(hw)) {
    surfaceCat = "Unpaved / Gravel";
  } else if (!surf && ["cycleway", "primary", "secondary", "tertiary", "residential", "living_street", "service"].includes(hw)) {
    surfaceCat = "Paved Smooth";
  }

  let roadCat = "Local Street";
  if (hw === "cycleway" || cycleway === "track" || cycleway === "opposite_track") {
    roadCat = "Protected Cycleway";
  } else if (cycleway === "lane" || cycleway === "shared_lane" || bicycle === "designated") {
    roadCat = "Cycle Lane / Shared";
  } else if (["residential", "living_street", "service", "pedestrian"].includes(hw)) {
    roadCat = "Local Street";
  } else if (["tertiary", "tertiary_link", "unclassified"].includes(hw)) {
    roadCat = "Tertiary Road";
  } else if (["secondary", "secondary_link"].includes(hw)) {
    roadCat = "Secondary Road";
  } else if (["primary", "primary_link", "trunk", "trunk_link"].includes(hw)) {
    roadCat = "Main Road";
  } else if (["path", "track", "footway", "bridleway", "steps"].includes(hw)) {
    roadCat = "Path / Track";
  }

  let trafficCat = "Low Traffic";
  if (roadCat === "Protected Cycleway" || roadCat === "Path / Track" || trafficClass === 1 || trafficClass === 2) {
    trafficCat = "Quiet / Traffic-Free";
  } else if (trafficClass === 3 || roadCat === "Local Street" || roadCat === "Cycle Lane / Shared") {
    trafficCat = "Low Traffic";
  } else if (trafficClass === 4 || roadCat === "Tertiary Road" || roadCat === "Secondary Road") {
    trafficCat = "Moderate Traffic";
  } else {
    trafficCat = "High Traffic";
  }

  let noiseCat = "Quiet";
  if (noiseClass >= 5 || roadCat === "Main Road") {
    noiseCat = "Loud";
  } else if (noiseClass >= 3 || roadCat === "Secondary Road" || roadCat === "Tertiary Road") {
    noiseCat = "Moderate";
  }

  let speedCat = "≤ 30 km/h";
  if (roadCat === "Protected Cycleway" || roadCat === "Path / Track") {
    speedCat = "Off-road / Cycleway";
  } else if (maxspeed >= 80 || hw === "trunk") {
    speedCat = "≥ 80 km/h";
  } else if (maxspeed >= 60 || hw === "primary") {
    speedCat = "60–70 km/h";
  } else if (maxspeed >= 40 || hw === "secondary" || hw === "tertiary") {
    speedCat = "40–50 km/h";
  }

  const warnings = [];
  if (hw === "steps") warnings.push({ kind: "steps", label: "Steps / stairs — dismount required" });
  if ((hw === "footway" || hw === "pedestrian") && bicycle !== "yes" && bicycle !== "designated") {
    warnings.push({ kind: "dismount", label: "Pedestrian section — cycling may require dismount" });
  }
  if (tags.route === "ferry") warnings.push({ kind: "ferry", label: "Ferry crossing along route" });
  if (tags.ford === "yes") warnings.push({ kind: "ford", label: "Ford / water crossing" });
  if ((maxspeed >= 70 || hw === "primary" || hw === "trunk") && roadCat !== "Protected Cycleway") {
    warnings.push({ kind: "high_speed", label: "High-speed road segment without protected track" });
  }
  if (surfaceCat === "Unpaved / Gravel" || surfaceCat === "Paved Rough") {
    warnings.push({ kind: "rough_surface", label: `${surfaceCat} surface segment` });
  }

  return { surfaceCat, roadCat, trafficCat, noiseCat, speedCat, warnings };
}

const CATEGORY_COLORS = {
  "Paved Smooth": "#10b981",
  "Paved Rough": "#8b5cf6",
  "Compacted": "#3b82f6",
  "Unpaved / Gravel": "#f59e0b",
  "Protected Cycleway": "#10b981",
  "Cycle Lane / Shared": "#3b82f6",
  "Path / Track": "#06b6d4",
  "Local Street": "#6366f1",
  "Tertiary Road": "#f59e0b",
  "Secondary Road": "#f97316",
  "Main Road": "#ef4444",
  "Quiet / Traffic-Free": "#10b981",
  "Low Traffic": "#3b82f6",
  "Moderate Traffic": "#f59e0b",
  "High Traffic": "#ef4444",
  "Quiet": "#10b981",
  "Moderate": "#f59e0b",
  "Loud": "#ef4444",
  "Off-road / Cycleway": "#10b981",
  "≤ 30 km/h": "#3b82f6",
  "40–50 km/h": "#f59e0b",
  "60–70 km/h": "#f97316",
  "≥ 80 km/h": "#ef4444",
};

function mergeRangeInto(ranges, i0, i1) {
  if (i1 <= i0) return;
  const last = ranges[ranges.length - 1];
  if (last && last[1] >= i0) {
    last[1] = Math.max(last[1], i1);
  } else {
    ranges.push([i0, i1]);
  }
}

function summarizeCategories(buckets, rangesBuckets, totalDistM) {
  const safeTotal = Math.max(1, totalDistM);
  return Object.entries(buckets)
    .filter(([, dist]) => dist > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([label, distM]) => ({
      label,
      color: CATEGORY_COLORS[label] || "#7c6df5",
      distance_m: Math.round(distM),
      pct: Math.max(1, Math.round((distM / safeTotal) * 100)),
      ranges: (rangesBuckets && rangesBuckets[label]) || [],
    }));
}

function findRangeByDist(cumDists, fromM, toM) {
  if (!cumDists || cumDists.length < 2) return [0, 0];
  let i0 = 0;
  while (i0 < cumDists.length - 2 && cumDists[i0 + 1] < fromM) i0++;
  let i1 = i0 + 1;
  while (i1 < cumDists.length - 1 && cumDists[i1] < toM) i1++;
  return [i0, i1];
}

function analyzeBrouterGeoJson(geojson, profileName, altIdx) {
  const feat = geojson?.features?.[0];
  if (!feat || !feat.geometry || !Array.isArray(feat.geometry.coordinates)) {
    return null;
  }
  const coords = feat.geometry.coordinates;
  if (coords.length < 2) return null;
  const props = feat.properties || {};
  const totalDistM = Number(props["track-length"] || 0);
  const ascentM = Number(props["filtered ascend"] || props["plain-ascend"] || 0);
  const plainAscend = Number(props["plain-ascend"] || 0);
  const descentM = Math.max(0, Math.round(ascentM - ( (coords[coords.length - 1][2] || 0) - (coords[0][2] || 0) )));
  const timeS = Number(props["total-time"] || Math.round(totalDistM / ((PROFILE_META[profileName]?.speedKmh || 20) / 3.6)));
  const energyJ = Number(props["total-energy"] || totalDistM * 32);
  const energyKcal = Math.max(1, Math.round(energyJ / 4184));
  const cost = Number(props["cost"] || Math.round(totalDistM * 1.2));

  const surfaceBuckets = {};
  const roadBuckets = {};
  const trafficBuckets = {};
  const noiseBuckets = {};
  const speedBuckets = {};
  const surfaceRanges = {};
  const roadRanges = {};
  const trafficRanges = {};
  const noiseRanges = {};
  const speedRanges = {};
  const warningMap = new Map();
  const segmentsByTab = {
    surface: [],
    road: [],
    traffic: [],
    noise: [],
    speed: [],
  };

  const step = Math.max(1, Math.ceil(coords.length / 250));
  const sampledCoords = [];
  const sampledPts2d = [];
  const sampledCumDists = [0];
  const elevationSeries = [];
  let cumDistM = 0;
  let prev = coords[0];
  sampledCoords.push([
    Number(prev[0].toFixed(5)),
    Number(prev[1].toFixed(5)),
    Math.round(Number(prev[2] ?? 15)),
  ]);
  sampledPts2d.push([Number(prev[0].toFixed(5)), Number(prev[1].toFixed(5))]);
  elevationSeries.push([0, Math.round(Number(prev[2] ?? 15)), 0]);

  for (let i = step; i < coords.length; i += step) {
    const pt = coords[i];
    const segM = haversineMeters(prev[0], prev[1], pt[0], pt[1]);
    cumDistM += segM;
    const ele = Math.round(Number(pt[2] ?? 15));
    const prevEle = sampledCoords[sampledCoords.length - 1][2];
    const grad = segM > 5 ? Math.round(((ele - prevEle) / segM) * 1000) / 10 : 0;
    const curIdx = sampledPts2d.length;
    if (Math.abs(grad) >= 12) {
      const cur = warningMap.get("steep") || { kind: "steep", label: "Steep gradient (≥ 12%)", distance_m: 0, count: 0, ranges: [] };
      cur.distance_m += Math.round(segM);
      cur.count += 1;
      mergeRangeInto(cur.ranges, curIdx - 1, curIdx);
      warningMap.set("steep", cur);
    }
    sampledCoords.push([Number(pt[0].toFixed(5)), Number(pt[1].toFixed(5)), ele]);
    sampledPts2d.push([Number(pt[0].toFixed(5)), Number(pt[1].toFixed(5))]);
    sampledCumDists.push(cumDistM);
    elevationSeries.push([
      Math.round((cumDistM / 1000) * 100) / 100,
      ele,
      Math.max(-25, Math.min(25, grad)),
    ]);
    prev = pt;
  }
  const last = coords[coords.length - 1];
  if (prev !== last) {
    const segM = haversineMeters(prev[0], prev[1], last[0], last[1]);
    cumDistM += segM;
    const ele = Math.round(Number(last[2] ?? 15));
    sampledCoords.push([Number(last[0].toFixed(5)), Number(last[1].toFixed(5)), ele]);
    sampledPts2d.push([Number(last[0].toFixed(5)), Number(last[1].toFixed(5))]);
    sampledCumDists.push(cumDistM);
    elevationSeries.push([Math.round((cumDistM / 1000) * 100) / 100, ele, 0]);
  }

  const messages = Array.isArray(props.messages) ? props.messages.slice(1) : [];
  if (messages.length > 0) {
    let msgCumDistM = 0;
    const scaleFactor = totalDistM > 0 && cumDistM > 0 ? cumDistM / totalDistM : 1;
    for (let i = 0; i < messages.length; i++) {
      const row = messages[i];
      const segDist = Number(row[3] || 0);
      const fromM = msgCumDistM * scaleFactor;
      msgCumDistM += segDist;
      const toM = msgCumDistM * scaleFactor;
      const [r0, r1] = findRangeByDist(sampledCumDists, fromM, toM);
      const tags = parseWayTags(row[9] || "");
      const cls = classifyWay(tags);
      surfaceBuckets[cls.surfaceCat] = (surfaceBuckets[cls.surfaceCat] || 0) + segDist;
      roadBuckets[cls.roadCat] = (roadBuckets[cls.roadCat] || 0) + segDist;
      trafficBuckets[cls.trafficCat] = (trafficBuckets[cls.trafficCat] || 0) + segDist;
      noiseBuckets[cls.noiseCat] = (noiseBuckets[cls.noiseCat] || 0) + segDist;
      speedBuckets[cls.speedCat] = (speedBuckets[cls.speedCat] || 0) + segDist;
      if (r1 > r0) {
        mergeRangeInto((surfaceRanges[cls.surfaceCat] ||= []), r0, r1);
        mergeRangeInto((roadRanges[cls.roadCat] ||= []), r0, r1);
        mergeRangeInto((trafficRanges[cls.trafficCat] ||= []), r0, r1);
        mergeRangeInto((noiseRanges[cls.noiseCat] ||= []), r0, r1);
        mergeRangeInto((speedRanges[cls.speedCat] ||= []), r0, r1);
        const pushTabSeg = (arr, label) => {
          const prevSeg = arr[arr.length - 1];
          if (prevSeg && prevSeg.label === label) {
            prevSeg.distance_m = Math.round(prevSeg.distance_m + segDist);
            prevSeg.to_m = Math.round(msgCumDistM);
            prevSeg.range[1] = Math.max(prevSeg.range[1], r1);
          } else {
            arr.push({
              label,
              color: CATEGORY_COLORS[label] || "#7c6df5",
              distance_m: Math.round(segDist),
              from_m: Math.round(msgCumDistM - segDist),
              to_m: Math.round(msgCumDistM),
              range: [r0, r1],
            });
          }
        };
        pushTabSeg(segmentsByTab.surface, cls.surfaceCat);
        pushTabSeg(segmentsByTab.road, cls.roadCat);
        pushTabSeg(segmentsByTab.traffic, cls.trafficCat);
        pushTabSeg(segmentsByTab.noise, cls.noiseCat);
        pushTabSeg(segmentsByTab.speed, cls.speedCat);
      }
      for (const w of cls.warnings) {
        const cur = warningMap.get(w.kind) || { kind: w.kind, label: w.label, distance_m: 0, count: 0, ranges: [] };
        cur.distance_m += segDist;
        cur.count += 1;
        if (r1 > r0) mergeRangeInto(cur.ranges, r0, r1);
        warningMap.set(w.kind, cur);
      }
    }
  }

  return {
    profile: profileName,
    alt: altIdx,
    engine: "wasm-rd5",
    distance_m: Math.round(totalDistM || cumDistM),
    ascent_m: Math.round(ascentM || plainAscend),
    descent_m: Math.round(descentM),
    time_s: Math.round(timeS),
    energy_kcal: energyKcal,
    cost: Math.round(cost),
    coords: sampledCoords,
    elevation: elevationSeries,
    breakdown: {
      route_coords: sampledPts2d,
      surface: summarizeCategories(surfaceBuckets, surfaceRanges, totalDistM || cumDistM),
      road: summarizeCategories(roadBuckets, roadRanges, totalDistM || cumDistM),
      traffic: summarizeCategories(trafficBuckets, trafficRanges, totalDistM || cumDistM),
      noise: summarizeCategories(noiseBuckets, noiseRanges, totalDistM || cumDistM),
      speed: summarizeCategories(speedBuckets, speedRanges, totalDistM || cumDistM),
      segments_by_tab: segmentsByTab,
      warnings: Array.from(warningMap.values()).map((w) => ({
        ...w,
        distance_m: Math.round(w.distance_m),
      })),
    },
  };
}

function buildGpxXml(slotResult, waypoints) {
  if (!slotResult || !Array.isArray(slotResult.coords) || slotResult.coords.length === 0) {
    return "";
  }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Gabi\'s Bike Router (Pronto + BRouter Wasm)" xmlns="http://www.topografix.com/GPX/1/1">',
    "  <metadata>",
    `    <name>Gabi's Bike Route (${slotResult.profile})</name>`,
    "  </metadata>",
  ];
  for (let i = 0; i < (waypoints || []).length; i++) {
    const wp = waypoints[i];
    const label = String(wp[2] || `Waypoint ${i + 1}`).replace(/[<>&"']/g, "");
    lines.push(`  <wpt lat="${Number(wp[1]).toFixed(5)}" lon="${Number(wp[0]).toFixed(5)}"><name>${label}</name></wpt>`);
  }
  lines.push("  <trk>");
  lines.push(`    <name>${slotResult.profile} (${(slotResult.distance_m / 1000).toFixed(1)} km)</name>`);
  lines.push("    <trkseg>");
  for (const pt of slotResult.coords) {
    lines.push(`      <trkpt lat="${pt[1]}" lon="${pt[0]}"><ele>${pt[2]}</ele></trkpt>`);
  }
  lines.push("    </trkseg>");
  lines.push("  </trk>");
  lines.push("</gpx>");
  return lines.join("\n");
}

function extractGpxWaypoints(xml) {
  const pts = [];
  const re = /<(?:trkpt|rtept|wpt)\s+[^>]*lat=["']([^"']+)["'][^>]*lon=["']([^"']+)["'][^>]*>|<(?:trkpt|rtept|wpt)\s+[^>]*lon=["']([^"']+)["'][^>]*lat=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const lat = parseFloat(m[1] ?? m[4]);
    const lon = parseFloat(m[2] ?? m[3]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      pts.push([Number(lon.toFixed(5)), Number(lat.toFixed(5))]);
    }
  }
  if (pts.length <= 2) return pts;
  const first = pts[0];
  const mid = pts[Math.floor(pts.length / 2)];
  const last = pts[pts.length - 1];
  const distMid = haversineMeters(first[0], first[1], mid[0], mid[1]);
  if (distMid > 250 && pts.length >= 6) {
    return [first, mid, last];
  }
  return [first, last];
}

async function downloadSegmentFromCdn(segName) {
  const cached = await idbGet("segments", segName);
  if (cached && cached.bytes instanceof Uint8Array && cached.bytes.byteLength >= 200) {
    segmentBuffers.set(segName, cached.bytes);
    return cached.bytes.byteLength;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetch(`${SEGMENT_BASE_URL}/${segName}.rd5`, { signal: controller.signal });
    if (!res.ok) return 0;
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/html")) return 0;
    const ab = await res.arrayBuffer();
    const bytes = new Uint8Array(ab);
    if (bytes.byteLength < 200) return 0;
    segmentBuffers.set(segName, bytes);
    await idbPut("segments", { name: segName, bytes, updated_at: Date.now() });
    if (IS_SURITA_ORIGIN) {
      const pmRes = await fetch(`${PMTILES_BASE_URL}/${segName}.pmtiles`, {
        headers: { range: "bytes=0-16383" },
        signal: controller.signal,
      });
      if (pmRes.ok) {
        await pmRes.arrayBuffer();
      }
    }
    return bytes.byteLength;
  } catch (_) {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

async function handleOfflineCommand(cmd) {
  if (!cmd || !cmd.region) return;
  const item = OFFLINE_CATALOG[cmd.region];
  if (!item) return;
  if (cmd.op === "delete") {
    installedBundles.delete(item.id);
    for (const seg of item.segments) {
      await idbDelete("segments", seg);
      segmentBuffers.delete(seg);
    }
    await idbDelete("bundles", item.id);
    return;
  }
  if (cmd.op === "download") {
    let loadedBytes = 0;
    let loadedCount = 0;
    for (const seg of item.segments) {
      const segBytes = await downloadSegmentFromCdn(seg);
      if (segBytes > 0) {
        loadedBytes += segBytes;
        loadedCount += 1;
      }
    }
    const ok = loadedCount === item.segments.length;
    const record = {
      id: item.id,
      status: ok ? "installed" : "error",
      segments_cached: loadedCount,
      segments_ready: loadedCount,
      pmtiles_ready: ok ? "yes" : "no",
      bytes_stored: loadedBytes,
      updated_at: Date.now(),
    };
    installedBundles.set(item.id, record);
    await idbPut("bundles", record);
  }
}

async function runWithSegmentLoading(router, invokeFn) {
  let result = null;
  for (let pass = 0; pass < 3; pass++) {
    try {
      result = invokeFn();
    } catch (_) {
      result = null;
    }
    const missing = router.take_missing_segments();
    if (!Array.isArray(missing) || missing.length === 0) {
      return result;
    }
    let anyLoaded = false;
    for (const mSeg of missing) {
      if (await ensureSegmentLoaded(mSeg)) anyLoaded = true;
    }
    if (!anyLoaded) {
      return result;
    }
  }
  router.take_missing_segments();
  return result;
}

async function computeRouteRequest(requestKey) {
  let req;
  try {
    req = JSON.parse(requestKey);
  } catch (_) {
    return null;
  }

  const router = await ensureRouter();

  if (req.offline) {
    await handleOfflineCommand(req.offline);
  }

  let matchedWaypoints = [];
  if (req.gpx && req.gpx.xml) {
    const profile = req.gpx.profile || "gabis-fast-city";
    const rawMatchedStr = await runWithSegmentLoading(
      router,
      () => router.match_gpx_waypoints(req.gpx.xml, profile, 25),
    );
    if (rawMatchedStr) {
      const rawMatched = JSON.parse(rawMatchedStr);
      if (Array.isArray(rawMatched?.waypoints) && rawMatched.waypoints.length >= 2) {
        matchedWaypoints = rawMatched.waypoints.map((w, idx) => [
          Number(Number(w.lon).toFixed(5)),
          Number(Number(w.lat).toFixed(5)),
          idx === 0 ? "GPX Start" : idx === rawMatched.waypoints.length - 1 ? "GPX Finish" : `GPX Via ${idx}`,
        ]);
      }
    }
    if (matchedWaypoints.length < 2) {
      const pts = extractGpxWaypoints(req.gpx.xml);
      matchedWaypoints = pts.map((pt, idx) => [
        pt[0],
        pt[1],
        idx === 0 ? "GPX Start" : idx === pts.length - 1 ? "GPX Finish" : `GPX Via ${idx}`,
      ]);
    }
  }

  const waypoints = matchedWaypoints.length >= 2 ? matchedWaypoints : Array.isArray(req.w) ? req.w : [];
  const avoids = Array.isArray(req.a) ? req.a : [];
  const profiles = Array.isArray(req.p) && req.p.length === 3
    ? req.p
    : ["gabis-fast-city", "gabis-safe-road", "gabis-lite-gravel"];
  const alts = Array.isArray(req.alt) && req.alt.length === 3 ? req.alt : [0, 0, 0];
  const activeSlot = Number(req.active || 0);

  let customLoaded = false;
  if (req.brf && typeof req.brf === "string" && req.brf.trim().length > 0) {
    router.load_profile("custom", req.brf);
    customLoaded = true;
  } else {
    router.load_profile("custom", PROFILES["gabis-fast-city"]);
    customLoaded = true;
  }

  const neededSegments = new Set();
  for (const wp of waypoints) {
    if (Array.isArray(wp) && wp.length >= 2) {
      neededSegments.add(segmentNameFor(Number(wp[0]), Number(wp[1])));
    }
  }
  if (Array.isArray(req.ins) && req.ins.length >= 2) {
    neededSegments.add(segmentNameFor(Number(req.ins[0]), Number(req.ins[1])));
  }
  for (const segName of neededSegments) {
    await ensureSegmentLoaded(segName);
  }

  const slotResults = [];
  if (waypoints.length >= 2) {
    const wpStr = waypoints.map((w) => `${Number(w[0]).toFixed(6)},${Number(w[1]).toFixed(6)}`).join("|");
    const nogosStr = avoids.length > 0
      ? avoids.map((a) => `${Number(a[0]).toFixed(6)},${Number(a[1]).toFixed(6)},${Math.round(Number(a[2] || 500))}`).join("|")
      : null;

    for (let i = 0; i < 3; i++) {
      const prof = profiles[i] || "gabis-fast-city";
      const altIdx = Number(alts[i] || 0);
      const targetProf = prof === "custom" && !customLoaded ? "gabis-fast-city" : prof;
      const rawGeoJson = await runWithSegmentLoading(
        router,
        () => router.route(wpStr, targetProf, altIdx, nogosStr),
      );
      const slotRes = rawGeoJson ? analyzeBrouterGeoJson(JSON.parse(rawGeoJson), prof, altIdx) : null;
      slotResults.push(slotRes);
    }
  }

  let inspectInfo = null;
  if (Array.isArray(req.ins) && req.ins.length >= 2) {
    const iLon = Number(req.ins[0]);
    const iLat = Number(req.ins[1]);
    const rawInspectStr = await runWithSegmentLoading(
      router,
      () => router.inspect_point(iLon, iLat, 350),
    );
    if (rawInspectStr) {
      const rawInspect = JSON.parse(rawInspectStr);
      if (rawInspect && (rawInspect.highway || rawInspect.tags)) {
        const tags = Array.isArray(rawInspect.tags)
          ? rawInspect.tags
          : rawInspect.tags
          ? Object.entries(parseWayTags(rawInspect.tags)).map(([key, value]) => ({ key, value }))
          : [
            { key: "highway", value: String(rawInspect.highway || "unclassified") },
            ...(rawInspect.surface ? [{ key: "surface", value: String(rawInspect.surface) }] : []),
            ...(rawInspect.maxspeed ? [{ key: "maxspeed", value: `${rawInspect.maxspeed} km/h` }] : []),
            ...(rawInspect.traffic_class != null ? [{ key: "traffic_class", value: String(rawInspect.traffic_class) }] : []),
            ...(rawInspect.noise_class != null ? [{ key: "noise_class", value: String(rawInspect.noise_class) }] : []),
            ...(rawInspect.lit != null ? [{ key: "lit", value: rawInspect.lit ? "yes" : "no" }] : []),
            ...(rawInspect.sidewalk != null ? [{ key: "sidewalk", value: rawInspect.sidewalk ? "yes" : "no" }] : []),
          ];
        inspectInfo = {
          lon: Number(iLon.toFixed(5)),
          lat: Number(iLat.toFixed(5)),
          distance_m: Math.round(Number(rawInspect.distance_m || 0)),
          tags,
        };
      }
    }
  }

  const features = slotResults
    .map((s, idx) =>
      s && Array.isArray(s.coords) && s.coords.length >= 2
        ? {
          type: "Feature",
          properties: {
            slot: idx,
            profile: s.profile,
            alt: s.alt,
            active: idx === activeSlot ? "yes" : "no",
            color: (PROFILE_META[s.profile] || PROFILE_META["gabis-fast-city"]).color,
            distance_m: s.distance_m,
          },
          geometry: {
            type: "LineString",
            coordinates: s.coords,
          },
        }
        : null
    )
    .filter(Boolean);

  const activeResult = slotResults[activeSlot] || slotResults[0] || null;
  const gpxXml = activeResult ? buildGpxXml(activeResult, waypoints) : "";
  const bundlesMap = await idbGetAllBundles();

  return {
    request_key: requestKey,
    slot_0_json: JSON.stringify(slotResults[0] || {}),
    slot_1_json: JSON.stringify(slotResults[1] || {}),
    slot_2_json: JSON.stringify(slotResults[2] || {}),
    routes_geojson: JSON.stringify({ type: "FeatureCollection", features }),
    active_gpx: gpxXml,
    inspect_json: JSON.stringify(inspectInfo || {}),
    matched_waypoints_json: JSON.stringify(matchedWaypoints),
    offline_json: JSON.stringify(bundlesMap),
  };
}

let lastKey = "";

self.addEventListener("message", async (e) => {
  const d = e.data;
  if (!d || d.type !== "pronto:props") return;
  const requestKey = String(d.props?.request_key ?? "").trim();
  if (!requestKey || requestKey === lastKey) return;
  lastKey = requestKey;
  let detail;
  try {
    detail = await computeRouteRequest(requestKey);
  } catch (err) {
    lastKey = "";
    throw err;
  }
  if (!detail) {
    lastKey = "";
    return;
  }
  self.postMessage({
    type: "pronto:event",
    name: "routed",
    detail,
  });
});

postMessage({ type: "pronto:ready" });

