// map_action — processes interactive map events from shell/units/router-map
// (adding/dragging waypoints, placing/removing avoid areas, inspecting road tags).
const safeParse = (raw, fallback) => {
  if (!raw || typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
};

const buildRequestKey = (planner, slots, overrides = {}) => {
  const w = overrides.w ?? safeParse(planner.waypoints_json, []);
  const a = overrides.a ?? safeParse(planner.avoids_json, []);
  const active = overrides.active ?? Number(planner.active_slot ?? 0);
  const brf = overrides.brf ?? (planner.custom_brf ?? "");
  const ins = overrides.ins ?? null;
  const p = [0, 1, 2].map((i) => {
    const s = slots.find((r) => r.slot_index === i || r.id === `slot-${i}`);
    return s?.profile || (i === 0 ? "gabis-fast-city" : i === 1 ? "gabis-safe-road" : "gabis-lite-gravel");
  });
  const alt = [0, 1, 2].map((i) => {
    const s = slots.find((r) => r.slot_index === i || r.id === `slot-${i}`);
    return Number(s?.alt ?? 0);
  });
  return JSON.stringify({ w, a, p, alt, active, brf, ...(ins ? { ins } : {}) });
};

const pointToSegmentDistSq = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return (px - x1) * (px - x1) + (py - y1) * (py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return (px - projX) * (px - projX) + (py - projY) * (py - projY);
};

const closestLegInsertIndex = (waypoints, lon, lat) => {
  if (waypoints.length < 2) return waypoints.length;
  let bestIdx = waypoints.length - 1;
  let bestDistSq = Infinity;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    const dSq = pointToSegmentDistSq(lon, lat, Number(a[0]), Number(a[1]), Number(b[0]), Number(b[1]));
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestIdx = i + 1;
    }
  }
  return bestIdx;
};

(state, event) => {
  if (event.type !== "map_action") return { updates: [] };
  const detail = event.detail ?? {};
  const kind = String(detail.action ?? detail.kind ?? "");
  const lat = Number(Number(detail.lat ?? 0).toFixed(5));
  const lon = Number(Number(detail.lon ?? 0).toFixed(5));
  const idx = Number(detail.index ?? detail.id ?? -1);
  const customLabel = String(detail.label ?? "").trim();

  const planner = (state.rows.planner_state ?? [])[0];
  if (!planner) return { updates: [] };
  const slots = state.rows.route_slot ?? [];

  const waypoints = [...safeParse(planner.waypoints_json, [])];
  const avoids = [...safeParse(planner.avoids_json, [])];
  const radius = Number(planner.avoid_radius_m || 500);

  if (kind === "add_waypoint") {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { updates: [] };
    const label = customLabel || (waypoints.length === 0
      ? `Start (${lat.toFixed(4)}, ${lon.toFixed(4)})`
      : `Point ${waypoints.length + 1} (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
    waypoints.push([lon, lat, label]);
  } else if (kind === "add_via") {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { updates: [] };
    const insertAt = idx >= 1 && idx <= waypoints.length
      ? idx
      : closestLegInsertIndex(waypoints, lon, lat);
    const label = customLabel || `Via (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
    waypoints.splice(insertAt, 0, [lon, lat, label]);
  } else if (kind === "set_start") {
    if (idx >= 0 && idx < waypoints.length) {
      const [picked] = waypoints.splice(idx, 1);
      waypoints.unshift(picked);
    } else if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const label = customLabel || `Start (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
      if (waypoints.length === 0) waypoints.push([lon, lat, label]);
      else waypoints[0] = [lon, lat, label];
    } else {
      return { updates: [] };
    }
  } else if (kind === "set_end") {
    if (idx >= 0 && idx < waypoints.length) {
      const [picked] = waypoints.splice(idx, 1);
      waypoints.push(picked);
    } else if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const label = customLabel || `End (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
      if (waypoints.length < 2) waypoints.push([lon, lat, label]);
      else waypoints[waypoints.length - 1] = [lon, lat, label];
    } else {
      return { updates: [] };
    }
  } else if (kind === "move_waypoint") {
    if (idx < 0 || idx >= waypoints.length || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { updates: [] };
    }
    waypoints[idx] = [lon, lat, `${lat.toFixed(4)}, ${lon.toFixed(4)}`];
  } else if (kind === "remove_waypoint" || kind === "delete_waypoint") {
    if (idx < 0 || idx >= waypoints.length) return { updates: [] };
    waypoints.splice(idx, 1);
  } else if (kind === "add_avoid") {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { updates: [] };
    avoids.push([lon, lat, radius]);
  } else if (kind === "remove_avoid") {
    if (idx < 0 || idx >= avoids.length) return { updates: [] };
    avoids.splice(idx, 1);
  } else if (kind === "clear_avoids") {
    avoids.length = 0;
  } else if (kind === "inspect_point") {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { updates: [] };
    const request_key = buildRequestKey(planner, slots, { ins: [lon, lat] });
    return {
      updates: [{
        op: "patch",
        entity: "planner_state",
        id: "planner",
        row: {
          inspect_lon: String(lon),
          inspect_lat: String(lat),
          request_key,
        },
      }],
    };
  } else {
    return { updates: [] };
  }

  const waypoints_json = JSON.stringify(waypoints);
  const avoids_json = JSON.stringify(avoids);
  const start_label = waypoints[0]?.[2] || (waypoints[0] ? `${waypoints[0][1]}, ${waypoints[0][0]}` : "—");
  const end_label = waypoints.length >= 2
    ? (waypoints[waypoints.length - 1]?.[2] || `${waypoints[waypoints.length - 1][1]}, ${waypoints[waypoints.length - 1][0]}`)
    : "—";
  const request_key = buildRequestKey(planner, slots, { w: waypoints, a: avoids });

  return {
    updates: [{
      op: "patch",
      entity: "planner_state",
      id: "planner",
      row: {
        waypoints_json,
        waypoint_count: waypoints.length,
        avoids_json,
        avoid_count: avoids.length,
        start_label,
        end_label,
        ...(waypoints.length < 2 ? { routes_geojson: '{"type":"FeatureCollection","features":[]}', active_gpx: "" } : {}),
        request_key,
      },
    }],
  };
};
