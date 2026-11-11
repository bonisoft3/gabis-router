// elevation-chart — pure Jessie renderer for the route's elevation profile.
// Produces an allowlisted SVG chart with grade-colored vertical bars, elevation
// polyline, gridlines, hover crosshair, and ascent/descent readout.
const gradeColor = (grad) => {
  const g = Math.abs(Number(grad || 0));
  if (g >= 10) return "#991b1b";
  if (g >= 7) return "#dc2626";
  if (g >= 4) return "#d97706";
  if (g >= 2) return "#2563eb";
  return "#16a34a";
};

(rawValue) => {
  let payload = null;
  let hoverPermille = -1;
  if (typeof rawValue === "string" && rawValue.trim() !== "") {
    const parts = rawValue.split("\t");
    try {
      payload = JSON.parse(parts[0]);
    } catch (_) {
      payload = null;
    }
    if (parts.length > 1) {
      hoverPermille = Number(parts[1]);
    }
  }

  const pts = Array.isArray(payload?.points) ? payload.points : [];
  if (pts.length < 2) {
    return [
      {
        tag: "div",
        attrs: { class: "elevation-empty" },
        children: ["Select two or more points on the map or search to view the elevation profile."],
      },
    ];
  }

  const units = payload?.units === "imperial" ? "imperial" : "metric";
  const distFactor = units === "imperial" ? 0.621371 : 1;
  const eleFactor = units === "imperial" ? 3.28084 : 1;
  const distUnit = units === "imperial" ? "mi" : "km";
  const eleUnit = units === "imperial" ? "ft" : "m";

  const W = 680;
  const H = 136;
  const padL = 42;
  const padR = 14;
  const padT = 14;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxDist = Math.max(0.1, Number(pts[pts.length - 1][0] || 1));
  let minEle = Infinity;
  let maxEle = -Infinity;
  for (const p of pts) {
    const e = Number(p[1] || 0);
    if (e < minEle) minEle = e;
    if (e > maxEle) maxEle = e;
  }
  if (!Number.isFinite(minEle)) minEle = 0;
  if (!Number.isFinite(maxEle) || maxEle <= minEle) maxEle = minEle + 20;
  const eleSpan = Math.max(15, maxEle - minEle);

  const xOf = (d) => Math.round((padL + (Math.min(maxDist, Math.max(0, d)) / maxDist) * plotW) * 10) / 10;
  const yOf = (e) => Math.round((padT + plotH - ((e - minEle) / eleSpan) * plotH) * 10) / 10;

  const gridLines = [0, 0.5, 1].map((frac) => {
    const val = Math.round((minEle + eleSpan * frac) * eleFactor);
    const y = Math.round((padT + plotH * (1 - frac)) * 10) / 10;
    return {
      tag: "g",
      attrs: { class: "ele-grid-row" },
      children: [
        {
          tag: "line",
          attrs: {
            x1: String(padL),
            y1: String(y),
            x2: String(W - padR),
            y2: String(y),
            stroke: "#cbd5e1",
            "stroke-width": "1",
            "stroke-dasharray": "3 3",
          },
          children: [],
        },
        {
          tag: "text",
          attrs: {
            x: String(padL - 6),
            y: String(y),
            "text-anchor": "end",
            "dominant-baseline": "middle",
            class: "ele-axis-label",
          },
          children: [`${val}${eleUnit}`],
        },
      ],
    };
  });

  const bars = [];
  const step = Math.max(1, Math.floor(pts.length / 72));
  for (let i = 0; i < pts.length - 1; i += step) {
    const p1 = pts[i];
    const p2 = pts[Math.min(pts.length - 1, i + step)];
    const x1 = xOf(Number(p1[0]));
    const x2 = Math.max(x1 + 2, xOf(Number(p2[0])));
    const avgEle = (Number(p1[1]) + Number(p2[1])) / 2;
    const yTop = yOf(avgEle);
    const barH = Math.max(2, Math.round((padT + plotH - yTop) * 10) / 10);
    const grad = Number(p2[2] ?? p1[2] ?? 0);
    bars.push({
      tag: "rect",
      attrs: {
        x: String(x1),
        y: String(yTop),
        width: String(Math.max(1.5, Math.round((x2 - x1 - 0.5) * 10) / 10)),
        height: String(barH),
        fill: gradeColor(grad),
        class: "ele-grade-bar",
      },
      children: [],
    });
  }

  const polyPoints = pts
    .map((p) => `${xOf(Number(p[0]))},${yOf(Number(p[1]))}`)
    .join(" ");

  const distTicks = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
    const d = maxDist * frac;
    const x = xOf(d);
    const label = `${(d * distFactor).toFixed(1)} ${distUnit}`;
    return {
      tag: "text",
      attrs: {
        x: String(x),
        y: String(H - 6),
        "text-anchor": frac === 0 ? "start" : frac === 1 ? "end" : "middle",
        class: "ele-axis-label",
      },
      children: [label],
    };
  });

  const hoverNodes = [];
  let hoverReadout = "Hover chart to inspect gradient & sync with map";
  if (Number.isFinite(hoverPermille) && hoverPermille >= 0 && hoverPermille <= 1000) {
    const idx = Math.min(pts.length - 1, Math.max(0, Math.round((hoverPermille / 1000) * (pts.length - 1))));
    const hp = pts[idx];
    const hx = xOf(Number(hp[0]));
    const hy = yOf(Number(hp[1]));
    const hDist = (Number(hp[0]) * distFactor).toFixed(2);
    const hEle = Math.round(Number(hp[1]) * eleFactor);
    const hGrad = Number(hp[2] || 0).toFixed(1);
    hoverReadout = `${hDist} ${distUnit} · ${hEle} ${eleUnit} · ${hGrad}% grade`;
    hoverNodes.push(
      {
        tag: "line",
        attrs: {
          x1: String(hx),
          y1: String(padT),
          x2: String(hx),
          y2: String(padT + plotH),
          stroke: "#7C6DF5",
          "stroke-width": "1.5",
        },
        children: [],
      },
      {
        tag: "circle",
        attrs: {
          cx: String(hx),
          cy: String(hy),
          r: "4.5",
          stroke: "#ffffff",
          "stroke-width": "2",
          class: "ele-hover-dot",
        },
        children: [],
      },
    );
  }

  return [
    {
      tag: "div",
      attrs: { class: "elevation-chart-wrap" },
      children: [
        {
          tag: "div",
          attrs: { class: "elevation-meta-row" },
          children: [
            {
              tag: "span",
              attrs: { class: "elevation-hover-readout" },
              children: [hoverReadout],
            },
            {
              tag: "span",
              attrs: { class: "elevation-grade-key" },
              children: ["<2% flat · 2–4% mild · 4–7% climb · >7% steep"],
            },
          ],
        },
        {
          tag: "svg",
          attrs: {
            viewBox: `0 0 ${W} ${H}`,
            role: "img",
            "aria-label": "Route elevation profile",
            preserveAspectRatio: "none",
            class: "elevation-svg",
          },
          children: [
            ...gridLines,
            ...bars,
            {
              tag: "polyline",
              attrs: {
                points: polyPoints,
                stroke: "#7C6DF5",
                "stroke-width": "2",
                "stroke-linejoin": "round",
                "stroke-linecap": "round",
                class: "ele-line",
              },
              children: [],
            },
            ...distTicks,
            ...hoverNodes,
          ],
        },
      ],
    },
  ];
};
