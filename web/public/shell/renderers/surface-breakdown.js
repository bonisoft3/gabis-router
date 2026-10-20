// Jessie renderer for GBRouter surface, road, traffic, noise, and speed-limit breakdown bars.
// Evaluated inside an Omnishell SES Compartment and rendered via render.js HTML + SVG tags.
export default (raw) => {
  if (!raw || typeof raw !== "string") return [];
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!spec || typeof spec !== "object") return [];

  const SURFACE_META = {
    paved: { label: "Paved", color: "#10b981" },
    gravel: { label: "Gravel", color: "#f59e0b" },
    unpaved: { label: "Unpaved", color: "#d97706" },
    trail: { label: "Trail", color: "#854d0e" },
    cobblestone: { label: "Cobblestone", color: "#8b5cf6" },
    unknown: { label: "Unknown", color: "#94a3b8" },
  };

  const ROAD_META = {
    cycleway: { label: "Cycleway", color: "#06b6d4" },
    residential: { label: "Residential", color: "#10b981" },
    tertiary: { label: "Tertiary", color: "#eab308" },
    secondary: { label: "Secondary", color: "#f97316" },
    primary: { label: "Primary", color: "#ef4444" },
    path: { label: "Path", color: "#854d0e" },
    unknown: { label: "Unknown", color: "#94a3b8" },
  };

  const TRAFFIC_META = {
    traffic_free: { label: "Traffic-free", color: "#059669" },
    low: { label: "Low", color: "#84cc16" },
    acceptable: { label: "Acceptable", color: "#f59e0b" },
    heavy: { label: "Heavy", color: "#ef4444" },
  };

  const NOISE_META = {
    very_quiet: { label: "Low", color: "#10b981" },
    moderate: { label: "Moderate", color: "#f59e0b" },
    loud: { label: "High", color: "#ef4444" },
  };

  const SPEED_LIMIT_META = {
    car_free: { label: "Car-free", color: "#059669" },
    "20mph": { label: "20 mph", color: "#10b981" },
    "30mph": { label: "30 mph", color: "#84cc16" },
    "40mph": { label: "40 mph", color: "#eab308" },
    "50mph": { label: "50 mph", color: "#f97316" },
    "60mph": { label: "60 mph", color: "#ef4444" },
    "70mph": { label: "70 mph", color: "#991b1b" },
    untagged: { label: "Untagged", color: "#94a3b8" },
  };

  const classifySurface = (surface, highway) => {
    const s = String(surface || "").toLowerCase().trim();
    const h = String(highway || "").toLowerCase().trim();
    if (["asphalt", "paved", "concrete", "concrete:lanes", "concrete:plates", "tarmac"].includes(s)) {
      return "paved";
    }
    if (["cobblestone", "cobblestone:flattened", "sett", "paving_stones"].includes(s)) {
      return "cobblestone";
    }
    if (["gravel", "fine_gravel", "compacted", "pebblestone"].includes(s)) {
      return "gravel";
    }
    if (["dirt", "earth", "ground", "mud", "sand", "clay"].includes(s)) {
      return "trail";
    }
    if (["unpaved", "wood", "metal", "grass", "grass_paver"].includes(s)) {
      return "unpaved";
    }
    if (
      [
        "motorway",
        "trunk",
        "primary",
        "secondary",
        "tertiary",
        "residential",
        "living_street",
        "service",
        "cycleway",
        "pedestrian",
      ].includes(h)
    ) {
      return "paved";
    }
    if (h === "track") return "gravel";
    if (["path", "footway", "bridleway", "steps"].includes(h)) return "trail";
    return "unknown";
  };

  const classifyRoad = (highway) => {
    const h = String(highway || "").toLowerCase().trim();
    if (h === "cycleway") return "cycleway";
    if (["residential", "living_street", "service", "unclassified"].includes(h)) return "residential";
    if (["tertiary", "tertiary_link"].includes(h)) return "tertiary";
    if (["secondary", "secondary_link"].includes(h)) return "secondary";
    if (["primary", "primary_link", "trunk", "trunk_link", "motorway", "motorway_link"].includes(h)) {
      return "primary";
    }
    if (["path", "footway", "bridleway", "track", "steps", "pedestrian"].includes(h)) return "path";
    return "unknown";
  };

  const classifyTraffic = (traffic, highway) => {
    const h = String(highway || "").toLowerCase().trim();
    if (["cycleway", "path", "footway", "pedestrian", "bridleway", "track", "steps"].includes(h)) {
      return "traffic_free";
    }
    const t = Number(traffic || 0);
    if (t >= 4) return "heavy";
    if (t >= 2) return "acceptable";
    return "low";
  };

  const classifyNoise = (noise) => {
    const n = Number(noise || 0);
    if (n >= 4) return "loud";
    if (n >= 2) return "moderate";
    return "very_quiet";
  };

  const classifySpeedLimit = (maxspeed, highway) => {
    const h = String(highway || "").toLowerCase().trim();
    if (["cycleway", "path", "footway", "pedestrian", "bridleway", "track", "steps"].includes(h)) {
      return "car_free";
    }
    const spd = Number(maxspeed || 0);
    if (spd > 0) {
      if (spd <= 35) return "20mph";
      if (spd <= 55) return "30mph";
      if (spd <= 75) return "40mph";
      if (spd <= 95) return "50mph";
      if (spd <= 105) return "60mph";
      return "70mph";
    }
    return "untagged";
  };

  const formatDist = (m, units) => {
    if (units === "imperial") {
      const mi = m * 0.000621371;
      if (mi < 0.1) return `${Math.round(m * 3.28084)} ft`;
      return `${mi.toFixed(1)} mi`;
    }
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(1)} km`;
  };

  let rows = spec.rows;

  if (!Array.isArray(rows) && Array.isArray(spec.segments) && spec.segments.length > 0) {
    const segs = spec.segments;
    const units = spec.units === "imperial" ? "imperial" : "metric";
    const activeHl = spec.activeHighlight || null;

    const buildRow = (title, getCat, metaMap) => {
      const totals = {};
      const merged = [];
      let total = 0;

      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const len = Math.max(0, Number(s.to || 0) - Number(s.from || 0));
        if (len <= 0) continue;
        const cat = getCat(s);
        const meta = metaMap[cat] || { label: cat, color: "#94a3b8" };
        totals[meta.label] = (totals[meta.label] || 0) + len;
        total += len;
        const last = merged[merged.length - 1];
        if (last && last.label === meta.label) {
          last.len += len;
        } else {
          merged.push({
            label: meta.label,
            color: meta.color,
            len,
          });
        }
      }

      if (merged.length === 0 || total <= 0) return null;

      const activeLabel = activeHl && activeHl.rowTitle === title ? activeHl.label : null;
      let cursorX = 0;
      const rawRects = merged.map((seg) => {
        const w = Math.max(2, (seg.len / total) * 1000);
        const item = {
          label: seg.label,
          color: seg.color,
          len: seg.len,
          x: cursorX,
          w,
        };
        cursorX += w;
        return item;
      });

      const scale = cursorX > 0 ? 1000 / cursorX : 1;
      let normX = 0;
      const rects = rawRects.map((seg) => {
        const x = Number(normX.toFixed(1));
        const width = Number((seg.w * scale).toFixed(1));
        normX += width;
        const pct = Math.max(1, Math.round((seg.len / total) * 100));
        return {
          x,
          width,
          fill: seg.color,
          title: `${seg.label}: ${formatDist(seg.len, units)} (${pct}%) · Click to highlight on map`,
          active: activeLabel === seg.label,
          dimmed: Boolean(activeLabel && activeLabel !== seg.label),
        };
      });

      const items = Object.keys(metaMap)
        .map((cat) => {
          const meta = metaMap[cat];
          const dist = totals[meta.label] || 0;
          return { label: meta.label, color: meta.color, dist };
        })
        .filter((entry) => entry.dist > 0 && (Math.round((entry.dist / total) * 100) >= 1 || entry.dist >= 100))
        .map((entry) => {
          const pctNum = (entry.dist / total) * 100;
          const pctRound = pctNum < 1 ? "<1" : String(Math.round(pctNum));
          return {
            label: entry.label,
            pctLabel: `${entry.label} ${pctRound}%`,
            color: entry.color,
            title: `${entry.label}: ${formatDist(entry.dist, units)} (${pctNum.toFixed(1)}%) · Click to highlight on map`,
            active: activeLabel === entry.label,
            dimmed: Boolean(activeLabel && activeLabel !== entry.label),
          };
        });

      return { title, segments: rects, items };
    };

    rows = [
      buildRow("Surface", (s) => classifySurface(s.surface, s.highway), SURFACE_META),
      buildRow("Road Type", (s) => classifyRoad(s.highway), ROAD_META),
      buildRow("Traffic", (s) => classifyTraffic(s.traffic, s.highway), TRAFFIC_META),
      buildRow("Noise & pollution", (s) => classifyNoise(s.noise), NOISE_META),
      buildRow("Speed Limit", (s) => classifySpeedLimit(s.maxspeed, s.highway), SPEED_LIMIT_META),
    ].filter(Boolean);
  }

  if (!Array.isArray(rows) || rows.length === 0) return [];

  return rows.map((row) => ({
    tag: "div",
    attrs: { class: "profile-bar-row" },
    children: [
      {
        tag: "div",
        attrs: { class: "profile-bar-header" },
        children: [
          {
            tag: "span",
            attrs: { class: "profile-bar-label" },
            children: [String(row.title || "")],
          },
          {
            tag: "div",
            attrs: { class: "surface-legend" },
            children: (row.items || []).map((item) => ({
              tag: "span",
              attrs: {
                class: `surface-legend-item${item.active ? " is-active" : ""}${item.dimmed ? " is-dimmed" : ""}`,
                title: String(item.title || ""),
              },
              children: [
                {
                  tag: "svg",
                  attrs: {
                    class: "surface-dot",
                    width: 8,
                    height: 8,
                    viewBox: "0 0 8 8",
                  },
                  children: [
                    {
                      tag: "rect",
                      attrs: {
                        x: 0,
                        y: 0,
                        width: 8,
                        height: 8,
                        rx: 2,
                        fill: item.color,
                      },
                    },
                  ],
                },
                String(item.pctLabel || ""),
              ],
            })),
          },
        ],
      },
      {
        tag: "div",
        attrs: { class: "surface-bar" },
        children: [
          {
            tag: "svg",
            attrs: {
              viewBox: "0 0 1000 10",
              preserveAspectRatio: "none",
              role: "group",
              "aria-label": `${row.title || "Category"} breakdown`,
            },
            children: (row.segments || []).map((seg) => ({
              tag: "rect",
              attrs: {
                class: `surface-segment${seg.active ? " is-active" : ""}${seg.dimmed ? " is-dimmed" : ""}`,
                x: seg.x,
                y: 0,
                width: seg.width,
                height: 10,
                fill: seg.fill,
                title: String(seg.title || ""),
              },
            })),
          },
        ],
      },
    ],
  }));
};
