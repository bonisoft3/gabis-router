// Jessie renderer for the GBRouter SVG elevation profile chart.
// Evaluated inside an Omnishell SES Compartment and rendered via render.js SVG_TAGS.
// Supports both raw route data ({ coords, slotIdx, compact, units, hoverDist })
// and pre-computed path specs ({ areaD, lineD, ... }).
export default (raw) => {
  if (!raw || typeof raw !== "string") return [];
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!input || typeof input !== "object") return [];

  const RAD = Math.PI / 180;
  const haversineMeters = (lat1, lon1, lat2, lon2) => {
    const dLat = (lat2 - lat1) * RAD;
    const dLon = (lon2 - lon1) * RAD;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const gradeColor = (g) => {
    if (g >= 12) return "#dc2626";
    if (g >= 8) return "#f97316";
    if (g >= 4) return "#eab308";
    if (g >= -3) return "#22c55e";
    return "#3b82f6";
  };

  const formatEle = (m, units) => {
    if (units === "imperial") return `${Math.round(m * 3.28084)} ft`;
    return `${Math.round(m)} m`;
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

  let spec = input;

  if (!spec.areaD && Array.isArray(spec.coords) && spec.coords.length >= 2) {
    const rawCoords = spec.coords;
    const coords = [];
    const dist = [];
    const ele = [];
    let accDist = 0;

    for (let i = 0; i < rawCoords.length; i++) {
      const pt = rawCoords[i];
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const lon = Number(pt[0]);
      const lat = Number(pt[1]);
      const z = pt.length >= 3 && pt[2] !== null && pt[2] !== undefined ? Number(pt[2]) : 0;
      if (coords.length > 0) {
        const prev = coords[coords.length - 1];
        accDist += haversineMeters(prev[1], prev[0], lat, lon);
      }
      coords.push([lon, lat, z]);
      dist.push(accDist);
      ele.push(z);
    }

    const n = coords.length;
    const totalDist = dist[n - 1] || 0;
    if (n < 2 || totalDist <= 0) return [];

    const slotIdx = Number(spec.slotIdx || 0);
    const compact = Boolean(spec.compact);
    const units = spec.units === "imperial" ? "imperial" : "metric";

    const W = 600;
    const H = compact ? 74 : 96;
    const padL = 42;
    const padR = 10;
    const padT = 7;
    const padB = 17;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    let minEle = ele[0];
    let maxEle = ele[0];
    for (let i = 1; i < n; i++) {
      if (ele[i] < minEle) minEle = ele[i];
      if (ele[i] > maxEle) maxEle = ele[i];
    }
    const eleSpan = Math.max(maxEle - minEle, 10);

    const grades = new Array(n).fill(0);
    let j0 = 0;
    let j1 = 0;
    for (let i = 0; i < n; i++) {
      while (j0 < i && dist[i] - dist[j0] > 40) j0++;
      while (j1 < n - 1 && dist[j1] - dist[i] < 40) j1++;
      const dSpan = dist[j1] - dist[j0];
      grades[i] = dSpan >= 8 ? ((ele[j1] - ele[j0]) / dSpan) * 100 : 0;
    }

    const maxPoints = 280;
    const step = Math.max(1, Math.floor(n / maxPoints));
    const idxs = [];
    for (let i = 0; i < n; i += step) idxs.push(i);
    if (idxs[idxs.length - 1] !== n - 1) idxs.push(n - 1);

    const xOf = (d) => padL + (d / totalDist) * plotW;
    const yOf = (e) => padT + plotH - ((e - minEle) / eleSpan) * plotH;

    const pts = idxs.map((i) => `${xOf(dist[i]).toFixed(1)},${yOf(ele[i]).toFixed(1)}`);
    const lineD = `M ${pts.join(" L ")}`;
    const areaD = `${lineD} L ${(padL + plotW).toFixed(1)},${(padT + plotH).toFixed(1)} L ${padL.toFixed(1)},${(padT + plotH).toFixed(1)} Z`;

    const stops = [];
    let lastColor = "";
    for (let k = 0; k < idxs.length; k++) {
      const i = idxs[k];
      const offset = `${((dist[i] / totalDist) * 100).toFixed(1)}%`;
      const color = gradeColor(grades[i]);
      if (color !== lastColor || k === 0 || k === idxs.length - 1) {
        stops.push({ offset, color });
        lastColor = color;
      }
    }

    let cursorX = -100;
    let cursorY = -100;
    let cursorColor = "#ffffff";
    if (typeof spec.hoverDist === "number" && spec.hoverDist >= 0) {
      const target = Math.max(0, Math.min(totalDist, spec.hoverDist));
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (dist[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && Math.abs(dist[lo - 1] - target) < Math.abs(dist[lo] - target)) {
        lo = lo - 1;
      }
      cursorX = Number(xOf(dist[lo]).toFixed(1));
      cursorY = Number(yOf(ele[lo]).toFixed(1));
      cursorColor = gradeColor(grades[lo]);
    }

    spec = {
      W,
      H,
      padL,
      padR,
      padT,
      padB,
      gradId: `ec-grade-grad-${slotIdx}`,
      stops,
      areaD,
      lineD,
      maxEleLabel: formatEle(maxEle, units),
      midEleLabel: formatEle((minEle + maxEle) / 2, units),
      minEleLabel: formatEle(minEle, units),
      startDistLabel: formatDist(0, units),
      midDistLabel: formatDist(totalDist / 2, units),
      endDistLabel: formatDist(totalDist, units),
      cursorX,
      cursorY,
      cursorColor,
    };
  }

  if (!spec || !spec.areaD || !spec.lineD) return [];

  const W = spec.W || 600;
  const H = spec.H || 96;
  const padL = spec.padL || 42;
  const padR = spec.padR || 10;
  const padT = spec.padT || 7;
  const padB = spec.padB || 17;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const gradId = spec.gradId || "grade-grad-0";

  const stops = (spec.stops || []).map((s) => ({
    tag: "stop",
    attrs: {
      offset: s.offset,
      "stop-color": s.color,
    },
  }));

  const gridLines = [0, 0.5, 1].map((t) => ({
    tag: "line",
    attrs: {
      class: "ec-grid",
      x1: padL,
      y1: padT + plotH * t,
      x2: W - padR,
      y2: padT + plotH * t,
    },
  }));

  const labels = [
    {
      tag: "text",
      attrs: { class: "ec-label", x: padL - 5, y: padT + 4, "text-anchor": "end" },
      children: [String(spec.maxEleLabel || "")],
    },
    {
      tag: "text",
      attrs: { class: "ec-label", x: padL - 5, y: padT + plotH / 2 + 3, "text-anchor": "end" },
      children: [String(spec.midEleLabel || "")],
    },
    {
      tag: "text",
      attrs: { class: "ec-label", x: padL - 5, y: padT + plotH, "text-anchor": "end" },
      children: [String(spec.minEleLabel || "")],
    },
    {
      tag: "text",
      attrs: { class: "ec-label", x: padL, y: H - 2, "text-anchor": "start" },
      children: [String(spec.startDistLabel || "")],
    },
    {
      tag: "text",
      attrs: { class: "ec-label", x: padL + plotW / 2, y: H - 2, "text-anchor": "middle" },
      children: [String(spec.midDistLabel || "")],
    },
    {
      tag: "text",
      attrs: { class: "ec-label", x: W - padR, y: H - 2, "text-anchor": "end" },
      children: [String(spec.endDistLabel || "")],
    },
  ];

  const cursorNodes = [
    {
      tag: "line",
      attrs: {
        class: "ec-cursor",
        x1: spec.cursorX ?? -100,
        y1: padT,
        x2: spec.cursorX ?? -100,
        y2: padT + plotH,
      },
    },
    {
      tag: "circle",
      attrs: {
        class: "ec-cursor-dot",
        cx: spec.cursorX ?? -100,
        cy: spec.cursorY ?? -100,
        r: 4.5,
        stroke: spec.cursorColor || "#ffffff",
        "stroke-width": 2.5,
      },
    },
  ];

  return [
    {
      tag: "svg",
      attrs: {
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: "none",
        role: "group",
        "aria-label": "Elevation profile",
      },
      children: [
        {
          tag: "defs",
          children: [
            {
              tag: "linearGradient",
              attrs: {
                id: gradId,
                gradientUnits: "userSpaceOnUse",
                x1: padL,
                y1: 0,
                x2: W - padR,
                y2: 0,
              },
              children: stops,
            },
          ],
        },
        ...gridLines,
        {
          tag: "path",
          attrs: {
            class: "ec-area",
            d: spec.areaD,
          },
        },
        {
          tag: "path",
          attrs: {
            class: "ec-line",
            d: spec.lineD,
            stroke: `url(#${gradId})`,
          },
        },
        ...labels,
        ...cursorNodes,
      ],
    },
  ];
};
