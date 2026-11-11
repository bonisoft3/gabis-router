const formatDist = (meters, units) => {
  const m = Math.max(0, Number(meters || 0));
  if (units === "imperial") {
    return `${(m / 1609.344).toFixed(2)} mi`;
  }
  return `${(m / 1000).toFixed(2)} km`;
};

const extractIdx = (el, prefix) => {
  if (!el || !el.className) return -1;
  const cls = typeof el.className === "string" ? el.className : el.getAttribute("class") || "";
  const m = new RegExp(`\\b${prefix}(\\d+)\\b`).exec(cls);
  return m ? parseInt(m[1], 10) : -1;
};

const rangesToMultiLine = (routeCoords, ranges, directCoords) => {
  if (Array.isArray(directCoords) && directCoords.length > 0) return directCoords;
  if (!Array.isArray(routeCoords) || routeCoords.length < 2 || !Array.isArray(ranges)) return [];
  const lines = [];
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length < 2) continue;
    const i0 = Math.max(0, Math.min(routeCoords.length - 2, Number(r[0]) || 0));
    const i1 = Math.max(i0 + 1, Math.min(routeCoords.length - 1, Number(r[1]) || i0 + 1));
    const slice = routeCoords.slice(i0, i1 + 1);
    if (slice.length >= 2) lines.push(slice);
  }
  return lines;
};

export default (screen, { signal }) => {
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".gpx,application/gpx+xml,text/xml";
  fileInput.hidden = true;
  screen.append(fileInput);

  const tooltip = document.createElement("div");
  tooltip.className = "breakdown-hover-tooltip";
  tooltip.hidden = true;
  screen.append(tooltip);

  let pinnedTargetKey = "";
  let pinnedPayload = null;
  let lastBreakdownRaw = "";

  const postToMap = (msg) => {
    const iframe = screen.querySelector(".router-map-mount iframe") || screen.querySelector("iframe");
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage(msg, "*");
    }
  };

  const resetPinnedIfStale = () => {
    const source = screen.querySelector("#gpx-export-source");
    const rawBrk = source?.getAttribute("data-breakdown") ?? "";
    if (rawBrk !== lastBreakdownRaw) {
      const hadPrev = lastBreakdownRaw !== "";
      lastBreakdownRaw = rawBrk;
      if (hadPrev && (pinnedTargetKey || pinnedPayload || !tooltip.hidden)) {
        pinnedTargetKey = "";
        pinnedPayload = null;
        tooltip.hidden = true;
        postToMap({ type: "gabi:highlight", coordinates: [], color: "" });
        postToMap({ type: "gabi:hover-point", lon: null, lat: null });
      }
    }
    return rawBrk;
  };

  const brkObserver = new MutationObserver(() => {
    resetPinnedIfStale();
  });
  brkObserver.observe(screen, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-breakdown"],
  });

  const getBreakdownContext = () => {
    const source = screen.querySelector("#gpx-export-source");
    const rawBrk = resetPinnedIfStale();
    const shellEl = screen.querySelector(".planner-shell");
    const activeTab =
      shellEl?.getAttribute("data-breakdown-tab") ||
      source?.getAttribute("data-tab") ||
      "surface";
    let parsed = null;
    if (rawBrk) {
      try {
        parsed = JSON.parse(rawBrk);
      } catch (_) {
        parsed = null;
      }
    }
    return {
      breakdown: parsed?.breakdown ?? {},
      units: parsed?.units === "imperial" ? "imperial" : "metric",
      activeTab,
    };
  };

  const resolveHoverTarget = (target) => {
    if (!target || typeof target.closest !== "function") return null;
    const segEl = target.closest(".breakdown-bar-seg");
    const rowEl = target.closest(".breakdown-row");
    const warnEl = target.closest(".warning-item");
    if (!segEl && !rowEl && !warnEl) return null;

    const { breakdown, units, activeTab } = getBreakdownContext();
    const routeCoords = Array.isArray(breakdown.route_coords) ? breakdown.route_coords : [];

    if (segEl) {
      const sIdx = extractIdx(segEl, "seg-idx-");
      const rawSegments = Array.isArray(breakdown?.segments_by_tab?.[activeTab])
        ? breakdown.segments_by_tab[activeTab]
        : [];
      const seg = rawSegments[sIdx];
      if (!seg) return null;
      const lines = rangesToMultiLine(routeCoords, seg.range ? [seg.range] : [], seg.coords);
      const midLine = lines[Math.floor(lines.length / 2)] || [];
      const midPt = midLine[Math.floor(midLine.length / 2)] || null;
      const rangeStr = seg.to_m > 0
        ? ` (${formatDist(seg.from_m || 0, units)} – ${formatDist(seg.to_m || 0, units)})`
        : "";
      return {
        key: `seg:${activeTab}:${sIdx}`,
        element: segEl,
        color: seg.color || "#10b981",
        coordinates: lines,
        hoverPt: midPt,
        label: `${seg.label}: ${formatDist(seg.distance_m || 0, units)}${rangeStr}`,
      };
    }

    if (rowEl) {
      const cIdx = extractIdx(rowEl, "cat-idx-");
      const items = Array.isArray(breakdown[activeTab]) ? breakdown[activeTab] : [];
      const item = items[cIdx];
      if (!item) return null;
      const lines = rangesToMultiLine(routeCoords, item.ranges, item.coords);
      const midLine = lines[0] || [];
      const midPt = midLine[Math.floor(midLine.length / 2)] || null;
      return {
        key: `cat:${activeTab}:${cIdx}`,
        element: rowEl,
        color: item.color || "#2563eb",
        coordinates: lines,
        hoverPt: midPt,
        label: `${item.label}: ${item.pct}% · ${formatDist(item.distance_m || 0, units)}`,
      };
    }

    if (warnEl) {
      const wIdx = extractIdx(warnEl, "warn-idx-");
      const warnings = Array.isArray(breakdown.warnings) ? breakdown.warnings : [];
      const w = warnings[wIdx];
      if (!w) return null;
      const lines = rangesToMultiLine(routeCoords, w.ranges, w.coords);
      const midLine = lines[0] || [];
      const midPt = midLine[Math.floor(midLine.length / 2)] || null;
      return {
        key: `warn:${wIdx}`,
        element: warnEl,
        color: "#ef4444",
        coordinates: lines,
        hoverPt: midPt,
        label: `${w.label}: ${formatDist(w.distance_m || 0, units)} (${w.count || 1}x)`,
      };
    }
    return null;
  };

  const applyHighlight = (info, clientX, clientY) => {
    if (!info) return;
    postToMap({
      type: "gabi:highlight",
      coordinates: info.coordinates,
      color: info.color,
      label: info.label,
    });
    if (Array.isArray(info.hoverPt) && info.hoverPt.length >= 2) {
      postToMap({
        type: "gabi:hover-point",
        lon: info.hoverPt[0],
        lat: info.hoverPt[1],
      });
    }
    if (typeof clientX === "number" && typeof clientY === "number") {
      tooltip.textContent = info.label;
      tooltip.hidden = false;
      tooltip.style.left = `${Math.min(window.innerWidth - 260, Math.max(12, clientX + 14))}px`;
      tooltip.style.top = `${Math.max(12, clientY - 36)}px`;
    }
  };

  const clearOrRestoreHighlight = () => {
    tooltip.hidden = true;
    if (pinnedPayload) {
      postToMap({
        type: "gabi:highlight",
        coordinates: pinnedPayload.coordinates,
        color: pinnedPayload.color,
        label: pinnedPayload.label,
      });
      if (Array.isArray(pinnedPayload.hoverPt) && pinnedPayload.hoverPt.length >= 2) {
        postToMap({
          type: "gabi:hover-point",
          lon: pinnedPayload.hoverPt[0],
          lat: pinnedPayload.hoverPt[1],
        });
      } else {
        postToMap({ type: "gabi:hover-point", lon: null, lat: null });
      }
    } else {
      postToMap({ type: "gabi:highlight", coordinates: [], color: "" });
      postToMap({ type: "gabi:hover-point", lon: null, lat: null });
    }
  };

  screen.addEventListener("pointerleave", clearOrRestoreHighlight, { signal });
  screen.addEventListener("pointerout", (event) => {
    const brkStage = screen.querySelector("#breakdown-stage");
    const eleStage = screen.querySelector("#elevation-stage");
    const fromStage =
      (brkStage && brkStage.contains(event.target)) ? brkStage :
      (eleStage && eleStage.contains(event.target)) ? eleStage :
      null;
    if (!fromStage) return;
    const next = event.relatedTarget;
    if (!next || !fromStage.contains(next)) {
      clearOrRestoreHighlight();
    }
  }, { signal });

  screen.addEventListener("pointermove", (event) => {
    const brkStage = screen.querySelector("#breakdown-stage");
    if (brkStage && brkStage.contains(event.target)) {
      const info = resolveHoverTarget(event.target);
      if (info) {
        applyHighlight(info, event.clientX, event.clientY);
        return;
      }
      clearOrRestoreHighlight();
      return;
    }

    const eleStage = screen.querySelector("#elevation-stage");
    if (eleStage && eleStage.contains(event.target)) {
      const svg = eleStage.querySelector("svg");
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const { breakdown, units } = getBreakdownContext();
      const routeCoords = Array.isArray(breakdown.route_coords) ? breakdown.route_coords : [];
      const source = screen.querySelector("#gpx-export-source");
      let elePoints = [];
      try {
        const parsedEle = JSON.parse(source?.getAttribute("data-elevation") || "{}");
        if (Array.isArray(parsedEle.points)) elePoints = parsedEle.points;
      } catch (_) {}

      if (routeCoords.length >= 2) {
        const rIdx = Math.min(routeCoords.length - 1, Math.max(0, Math.round(ratio * (routeCoords.length - 1))));
        const pt = routeCoords[rIdx];
        postToMap({
          type: "gabi:hover-point",
          lon: pt[0],
          lat: pt[1],
          permille: Math.round(ratio * 1000),
        });
      } else {
        postToMap({
          type: "gabi:hover-point",
          lon: null,
          lat: null,
          permille: Math.round(ratio * 1000),
        });
      }

      if (elePoints.length > 0) {
        const eIdx = Math.min(elePoints.length - 1, Math.max(0, Math.round(ratio * (elePoints.length - 1))));
        const ep = elePoints[eIdx];
        const distKm = Number(ep[0] || 0);
        const eleM = Number(ep[1] || 0);
        const grad = Number(ep[2] || 0);
        const distStr = units === "imperial" ? `${(distKm * 0.621371).toFixed(2)} mi` : `${distKm.toFixed(2)} km`;
        const eleStr = units === "imperial" ? `${Math.round(eleM * 3.28084)} ft` : `${Math.round(eleM)} m`;
        tooltip.textContent = `${distStr} · ${eleStr} (${grad >= 0 ? "+" : ""}${grad.toFixed(1)}%)`;
        tooltip.hidden = false;
        tooltip.style.left = `${Math.min(window.innerWidth - 240, Math.max(12, event.clientX + 12))}px`;
        tooltip.style.top = `${Math.max(12, event.clientY - 38)}px`;
      }
      return;
    }

    if (!tooltip.hidden) {
      clearOrRestoreHighlight();
    }
  }, { signal });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const text = await file.text();
    fileInput.value = "";
    const target = screen.querySelector("#gpx-import-payload");
    const trigger = screen.querySelector("#btn-apply-gpx");
    if (target && trigger) {
      target.value = text;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      trigger.click();
    }
  }, { signal });

  screen.addEventListener("click", (event) => {
    const brkStage = screen.querySelector("#breakdown-stage");
    if (brkStage && brkStage.contains(event.target)) {
      const info = resolveHoverTarget(event.target);
      if (info) {
        for (const el of brkStage.querySelectorAll(".is-pinned")) {
          el.classList.remove("is-pinned");
        }
        if (pinnedTargetKey === info.key) {
          pinnedTargetKey = "";
          pinnedPayload = null;
          clearOrRestoreHighlight();
        } else {
          pinnedTargetKey = info.key;
          pinnedPayload = info;
          info.element.classList.add("is-pinned");
          applyHighlight(info, event.clientX, event.clientY);
        }
        return;
      }
    }

    if (event.target?.closest?.(".breakdown-tabs .tab-btn")) {
      pinnedTargetKey = "";
      pinnedPayload = null;
      postToMap({ type: "gabi:highlight", coordinates: [], color: "" });
      postToMap({ type: "gabi:hover-point", lon: null, lat: null });
    }

    const btn = event.target?.closest?.("[data-host-dom='gpx-io']");
    if (!btn) return;

    if (btn.id === "btn-import-gpx") {
      fileInput.click();
      return;
    }

    if (btn.id === "btn-export-gpx") {
      const source = screen.querySelector("#gpx-export-source");
      const gpx = source?.getAttribute("data-gpx") ?? "";
      const profile = source?.getAttribute("data-profile") ?? "route";
      if (!gpx) return;
      const blob = new Blob([gpx], { type: "application/gpx+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gabi-router-${profile}.gpx`;
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return;
    }

    if (btn.id === "btn-share-route") {
      const source = screen.querySelector("#gpx-export-source");
      const wp = source?.getAttribute("data-waypoints") ?? "";
      const profile = source?.getAttribute("data-profile") ?? "fastbike";
      const shareUrl = new URL(window.location.href);
      shareUrl.searchParams.set("profile", profile);
      if (wp) shareUrl.searchParams.set("waypoints", wp);
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(shareUrl.toString()).catch(() => {});
      }
    }
  }, { signal });

  // Sandboxed realm iframes carry Origin: null; bridge host origin and byte-range
  // fetches so tiles.surita.dev (which allows https://router.surita.dev) works
  // there without triggering cross-origin console errors elsewhere.
  const hostOrigin = typeof window !== "undefined" ? window.location.origin : "";
  addEventListener("message", async (ev) => {
    const iframe = screen.querySelector(".router-map-mount iframe") || screen.querySelector("iframe");
    if (!iframe || ev.source !== iframe.contentWindow) return;
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "pronto:ready" || msg.type === "gabi:query-origin") {
      iframe.contentWindow.postMessage({ type: "gabi:host-origin", origin: hostOrigin }, "*");
      return;
    }
    if (msg.type === "gabi:pmtiles-range" && hostOrigin === "https://router.surita.dev") {
      try {
        const start = Number(msg.offset) || 0;
        const end = start + Math.max(1, Number(msg.length) || 1) - 1;
        const resp = await fetch(String(msg.url), {
          headers: { Range: `bytes=${start}-${end}` },
        });
        if (!resp.ok && resp.status !== 206) {
          iframe.contentWindow.postMessage({ type: "gabi:pmtiles-range-res", id: msg.id, error: `HTTP ${resp.status}` }, "*");
          return;
        }
        const buf = await resp.arrayBuffer();
        const etag = resp.headers.get("etag") || undefined;
        iframe.contentWindow.postMessage({ type: "gabi:pmtiles-range-res", id: msg.id, data: buf, etag }, "*", [buf]);
      } catch (err) {
        iframe.contentWindow.postMessage({ type: "gabi:pmtiles-range-res", id: msg.id, error: String(err) }, "*");
      }
    }
  }, { signal });

  return () => {
    brkObserver.disconnect();
    fileInput.remove();
    tooltip.remove();
  };
};
