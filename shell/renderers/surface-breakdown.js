// surface-breakdown — pure Jessie renderer for the 6-tab route breakdown
// (surface, road, traffic, noise, speed, warnings).
const TAB_TITLES = {
  surface: "Surface Quality",
  road: "Road & Cycleway Infrastructure",
  traffic: "Traffic Exposure",
  noise: "Ambient Noise Class",
  speed: "Speed Limit Distribution",
  warnings: "Route Advisory Warnings",
};

const FALLBACK_COLORS = {
  "Paved Smooth": "#10b981",
  "Asphalt": "#10b981",
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

const safeHex = (raw, label) => {
  if (typeof raw === "string" && /^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  const byLabel = FALLBACK_COLORS[String(label || "")];
  if (byLabel) return byLabel;
  return "#7c6df5";
};

const formatDist = (meters, units) => {
  const m = Math.max(0, Number(meters || 0));
  if (units === "imperial") {
    return `${(m / 1609.344).toFixed(2)} mi`;
  }
  return `${(m / 1000).toFixed(2)} km`;
};

const barToneClass = (label, idx) => {
  const l = String(label || "").toLowerCase();
  if (l.includes("cycleway") || l.includes("smooth") || l.includes("quiet") || l.includes("off-road")) {
    return "breakdown-row tone-good";
  }
  if (l.includes("lane") || l.includes("local") || l.includes("compacted") || l.includes("low") || l.includes("30")) {
    return "breakdown-row tone-calm";
  }
  if (l.includes("rough") || l.includes("gravel") || l.includes("moderate") || l.includes("tertiary") || l.includes("40")) {
    return "breakdown-row tone-warn";
  }
  if (l.includes("main") || l.includes("high") || l.includes("loud") || l.includes("60") || l.includes("70")) {
    return "breakdown-row tone-alert";
  }
  return `breakdown-row tone-${idx % 4}`;
};

(rawValue) => {
  let payload = null;
  let activeTab = "surface";
  if (typeof rawValue === "string" && rawValue.trim() !== "") {
    const parts = rawValue.split("\t");
    try {
      payload = JSON.parse(parts[0]);
    } catch (_) {
      payload = null;
    }
    if (parts[1]) activeTab = parts[1].trim();
  }

  const breakdown = payload?.breakdown ?? {};
  const units = payload?.units === "imperial" ? "imperial" : "metric";

  if (activeTab === "warnings") {
    const warnings = Array.isArray(breakdown.warnings) ? breakdown.warnings : [];
    if (warnings.length === 0) {
      return [
        {
          tag: "div",
          attrs: { class: "breakdown-empty" },
          children: ["No route warnings detected for this profile."],
        },
      ];
    }
    return [
      {
        tag: "ul",
        attrs: { class: "warnings-list" },
        children: warnings.map((w, idx) => ({
          tag: "li",
          attrs: {
            class: `warning-item warning-${w.kind || "info"} warn-idx-${idx}`,
            title: `${String(w.label || "Route caution")} (${formatDist(w.distance_m || 0, units)}) — Hover to highlight on map, click to pin`,
          },
          children: [
            {
              tag: "strong",
              attrs: { class: "warning-label" },
              children: [String(w.label || "Route caution")],
            },
            {
              tag: "span",
              attrs: { class: "warning-meta" },
              children: [`${formatDist(w.distance_m || 0, units)} · ${w.count || 1} section(s)`],
            },
          ],
        })),
      },
    ];
  }

  const items = Array.isArray(breakdown[activeTab]) ? breakdown[activeTab] : [];
  if (items.length === 0) {
    return [
      {
        tag: "div",
        attrs: { class: "breakdown-empty" },
        children: [`No ${TAB_TITLES[activeTab] || activeTab} breakdown available.`],
      },
    ];
  }

  const rawSegments = Array.isArray(breakdown?.segments_by_tab?.[activeTab]) && breakdown.segments_by_tab[activeTab].length > 0
    ? breakdown.segments_by_tab[activeTab]
    : items.map((it) => ({
      label: it.label,
      color: it.color,
      distance_m: it.distance_m,
      from_m: 0,
      to_m: it.distance_m,
    }));

  const totalSegDist = Math.max(
    1,
    rawSegments.reduce((acc, s) => acc + Math.max(1, Number(s.distance_m || 0)), 0),
  );
  let cursorX = 0;
  const barRects = rawSegments.map((seg, sIdx) => {
    const d = Math.max(1, Number(seg.distance_m || 0));
    const w = sIdx === rawSegments.length - 1
      ? Math.max(2, 600 - cursorX)
      : Math.max(2, Math.round((d / totalSegDist) * 600));
    const x = Math.min(598, cursorX);
    cursorX = Math.min(600, cursorX + w);
    const hex = safeHex(seg.color, seg.label);
    const rangeStr = seg.to_m > 0
      ? ` (${formatDist(seg.from_m || 0, units)} – ${formatDist(seg.to_m || 0, units)})`
      : "";
    return {
      tag: "rect",
      attrs: {
        x: String(x),
        y: "0",
        width: String(Math.max(2, Math.min(w, 600 - x))),
        height: "18",
        fill: hex,
        class: `breakdown-bar-seg seg-idx-${sIdx}`,
        title: `${String(seg.label || "Segment")}: ${formatDist(seg.distance_m || 0, units)}${rangeStr} — Hover to highlight on map`,
      },
    };
  });

  return [
    {
      tag: "div",
      attrs: { class: "breakdown-interactive-root" },
      children: [
        {
          tag: "svg",
          attrs: {
            viewBox: "0 0 600 18",
            preserveAspectRatio: "none",
            class: "breakdown-svg-bar",
            role: "img",
            "aria-label": `${TAB_TITLES[activeTab] || activeTab} route strip`,
          },
          children: barRects,
        },
        {
          tag: "div",
          attrs: { class: "breakdown-table-wrap" },
          children: items.map((item, idx) => {
            const pct = Math.max(0, Math.min(100, Math.round(Number(item.pct || 0))));
            const hex = safeHex(item.color, item.label);
            const distText = formatDist(item.distance_m || 0, units);
            return {
              tag: "div",
              attrs: {
                class: `${barToneClass(item.label, idx)} cat-idx-${idx}`,
                title: `${String(item.label || "Segment")}: ${pct}% · ${distText} — Hover to highlight on map, click to pin`,
              },
              children: [
                {
                  tag: "div",
                  attrs: { class: "breakdown-row-head" },
                  children: [
                    {
                      tag: "span",
                      attrs: { class: "breakdown-cat-title" },
                      children: [
                        {
                          tag: "svg",
                          attrs: {
                            viewBox: "0 0 12 12",
                            width: "10",
                            height: "10",
                            class: "breakdown-color-dot",
                            "aria-label": String(item.label || "Category"),
                          },
                          children: [
                            {
                              tag: "rect",
                              attrs: {
                                x: "1",
                                y: "1",
                                width: "10",
                                height: "10",
                                rx: "5",
                                fill: hex,
                              },
                            },
                          ],
                        },
                        {
                          tag: "strong",
                          attrs: { class: "breakdown-cat-label" },
                          children: [String(item.label || "Segment")],
                        },
                      ],
                    },
                    {
                      tag: "span",
                      attrs: { class: "breakdown-cat-stats" },
                      children: [`${pct}% · ${distText}`],
                    },
                  ],
                },
                {
                  tag: "svg",
                  attrs: {
                    viewBox: "0 0 200 6",
                    preserveAspectRatio: "none",
                    class: "breakdown-meter-svg",
                    role: "img",
                    "aria-label": `${pct}%`,
                  },
                  children: [
                    {
                      tag: "rect",
                      attrs: {
                        x: "0",
                        y: "0",
                        width: "200",
                        height: "6",
                        rx: "3",
                        fill: "#e2e8f0",
                      },
                    },
                    {
                      tag: "rect",
                      attrs: {
                        x: "0",
                        y: "0",
                        width: String(Math.max(4, pct * 2)),
                        height: "6",
                        rx: "3",
                        fill: hex,
                      },
                    },
                  ],
                },
              ],
            };
          }),
        },
      ],
    },
  ];
};
