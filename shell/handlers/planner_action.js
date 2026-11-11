// planner_action — handles user actions on the route planner sidebar,
// comparison slots, custom .brf studio, GPX import, and offline bundle manager.
const PROFILE_LABELS = {
  "gabis-fast-city": "profile_gabis_fast_city",
  "gabis-safe-road": "profile_gabis_safe_road",
  "gabis-lite-gravel": "profile_gabis_lite_gravel",
  "fastbike-lowtraffic": "profile_fastbike_lowtraffic",
  "fastbike-verylowtraffic": "profile_fastbike_verylowtraffic",
  "fastbike": "profile_fastbike",
  "gravel": "profile_gravel",
  "trekking": "profile_trekking",
  "mtb": "profile_mtb",
  "shortest": "profile_shortest",
  "custom": "profile_custom",
};

const PRESET_ROUTES = {
  "london": {
    center_lat: 51.5082,
    center_lon: -0.0950,
    zoom: 13.0,
    waypoints: [
      [-0.1276, 51.5072, "Trafalgar Square, London"],
      [-0.0754, 51.5055, "Tower Bridge, London"],
    ],
  },
  "saopaulo": {
    center_lat: -23.5740,
    center_lon: -46.6580,
    zoom: 13.2,
    waypoints: [
      [-46.6559, -23.5614, "Av. Paulista (MASP), São Paulo"],
      [-46.6601, -23.5874, "Parque Ibirapuera, São Paulo"],
    ],
  },
  "loop-london": {
    center_lat: 51.5220,
    center_lon: -0.1450,
    zoom: 12.8,
    waypoints: [
      [-0.1586, 51.5073, "Hyde Park Corner, London"],
      [-0.1534, 51.5313, "Regent's Park, London"],
      [-0.1276, 51.5072, "Trafalgar Square, London"],
    ],
  },
};

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
  const gpx = overrides.gpx ?? null;
  const offline = overrides.offline ?? null;
  const p = [0, 1, 2].map((i) => {
    if (overrides.slotProfile && overrides.slotProfile.index === i) {
      return overrides.slotProfile.profile;
    }
    const s = slots.find((r) => r.slot_index === i || r.id === `slot-${i}`);
    return s?.profile || (i === 0 ? "gabis-fast-city" : i === 1 ? "gabis-safe-road" : "gabis-lite-gravel");
  });
  const alt = [0, 1, 2].map((i) => {
    if (overrides.slotAlt && overrides.slotAlt.index === i) {
      return overrides.slotAlt.alt;
    }
    const s = slots.find((r) => r.slot_index === i || r.id === `slot-${i}`);
    return Number(s?.alt ?? 0);
  });
  return JSON.stringify({
    w,
    a,
    p,
    alt,
    active,
    brf,
    ...(gpx ? { gpx } : {}),
    ...(offline ? { offline } : {}),
  });
};

(state, event) => {
  const planner = (state.rows.planner_state ?? [])[0];
  if (!planner) return { updates: [] };
  const slots = state.rows.route_slot ?? [];
  const from = String(event.from ?? "");
  const rowId = String(event.id ?? "");

  // 1. PlaceSuggestion item clicked -> append as waypoint
  if (/^s[0-4]$/.test(rowId) && event.type === "click") {
    const sug = (state.rows.place_suggestion ?? []).find((s) => s.id === rowId);
    if (!sug) return { updates: [] };
    const lon = Number(Number(sug.longitude).toFixed(5));
    const lat = Number(Number(sug.latitude).toFixed(5));
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return { updates: [] };
    const waypoints = [...safeParse(planner.waypoints_json, [])];
    const label = sug.line1 || sug.label || `${lat}, ${lon}`;
    waypoints.push([lon, lat, label]);
    const waypoints_json = JSON.stringify(waypoints);
    const start_label = waypoints[0]?.[2] || `${waypoints[0][1]}, ${waypoints[0][0]}`;
    const end_label = waypoints.length >= 2
      ? (waypoints[waypoints.length - 1]?.[2] || `${waypoints[waypoints.length - 1][1]}, ${waypoints[waypoints.length - 1][0]}`)
      : "—";
    const request_key = buildRequestKey(planner, slots, { w: waypoints });
    return {
      updates: [{
        op: "patch",
        entity: "planner_state",
        id: "planner",
        row: {
          search_step: "idle",
          search_text: label,
          waypoints_json,
          waypoint_count: waypoints.length,
          start_label,
          end_label,
          center_lat: String(lat),
          center_lon: String(lon),
          request_key,
        },
      }],
    };
  }

  // 2. Preset route buttons (London, São Paulo, London Loop)
  if (from.startsWith("btn-preset-")) {
    const key = from.slice("btn-preset-".length);
    const preset = PRESET_ROUTES[key];
    if (!preset) return { updates: [] };
    const waypoints = preset.waypoints;
    const waypoints_json = JSON.stringify(waypoints);
    const request_key = buildRequestKey(planner, slots, { w: waypoints, a: [] });
    return {
      updates: [{
        op: "patch",
        entity: "planner_state",
        id: "planner",
        row: {
          waypoints_json,
          waypoint_count: waypoints.length,
          avoids_json: "[]",
          avoid_count: 0,
          start_label: waypoints[0][2],
          end_label: waypoints[waypoints.length - 1][2],
          center_lat: String(preset.center_lat),
          center_lon: String(preset.center_lon),
          zoom: String(preset.zoom),
          request_key,
        },
      }],
    };
  }

  // 3. Reverse route waypoints
  if (from === "btn-reverse-route") {
    const waypoints = [...safeParse(planner.waypoints_json, [])].reverse();
    if (waypoints.length < 2) return { updates: [] };
    const waypoints_json = JSON.stringify(waypoints);
    const request_key = buildRequestKey(planner, slots, { w: waypoints });
    return {
      updates: [{
        op: "patch",
        entity: "planner_state",
        id: "planner",
        row: {
          waypoints_json,
          start_label: waypoints[0]?.[2] || `${waypoints[0][1]}, ${waypoints[0][0]}`,
          end_label: waypoints[waypoints.length - 1]?.[2] || `${waypoints[waypoints.length - 1][1]}, ${waypoints[waypoints.length - 1][0]}`,
          request_key,
        },
      }],
    };
  }

  // 4. Round-trip loop generator (appends start point at end + intermediate scenic corner if needed)
  if (from === "btn-roundtrip-route") {
    const waypoints = [...safeParse(planner.waypoints_json, [])];
    if (waypoints.length === 0) return { updates: [] };
    const start = waypoints[0];
    if (waypoints.length === 1) {
      waypoints.push([Number((start[0] + 0.018).toFixed(5)), Number((start[1] + 0.012).toFixed(5)), "Loop Turnaround"]);
    }
    const last = waypoints[waypoints.length - 1];
    if (Math.hypot(last[0] - start[0], last[1] - start[1]) > 0.0005) {
      waypoints.push([start[0], start[1], `${start[2]} (Return)`]);
    }
    const waypoints_json = JSON.stringify(waypoints);
    const request_key = buildRequestKey(planner, slots, { w: waypoints });
    return {
      updates: [{
        op: "patch",
        entity: "planner_state",
        id: "planner",
        row: {
          waypoints_json,
          waypoint_count: waypoints.length,
          start_label: waypoints[0][2],
          end_label: waypoints[waypoints.length - 1][2],
          request_key,
        },
      }],
    };
  }

  // 4b. Remove individual waypoint from sidebar (start, via, or end)
  if (from === "btn-remove-start" || from === "btn-remove-via" || from === "btn-remove-end") {
    const waypoints = [...safeParse(planner.waypoints_json, [])];
    if (waypoints.length === 0) return { updates: [] };
    if (from === "btn-remove-start") {
      waypoints.shift();
    } else if (from === "btn-remove-via" && waypoints.length >= 3) {
      waypoints.splice(1, 1);
    } else if (from === "btn-remove-end" && waypoints.length >= 2) {
      waypoints.pop();
    } else {
      return { updates: [] };
    }
    const waypoints_json = JSON.stringify(waypoints);
    const start_label = waypoints[0]?.[2] || (waypoints[0] ? `${waypoints[0][1]}, ${waypoints[0][0]}` : "—");
    const end_label = waypoints.length >= 2
      ? (waypoints[waypoints.length - 1]?.[2] || `${waypoints[waypoints.length - 1][1]}, ${waypoints[waypoints.length - 1][0]}`)
      : "—";
    const request_key = buildRequestKey(planner, slots, { w: waypoints });
    return {
      updates: [{
        op: "patch",
        entity: "planner_state",
        id: "planner",
        row: {
          waypoints_json,
          waypoint_count: waypoints.length,
          start_label,
          end_label,
          ...(waypoints.length < 2 ? { routes_geojson: '{"type":"FeatureCollection","features":[]}', active_gpx: "" } : {}),
          request_key,
        },
      }],
    };
  }

  // 5. Confirm clear route
  if (from === "btn-clear-confirm") {
    const request_key = buildRequestKey(planner, slots, { w: [], a: [] });
    return {
      updates: [
        {
          op: "patch",
          entity: "planner_state",
          id: "planner",
          row: {
            waypoints_json: "[]",
            waypoint_count: 0,
            avoids_json: "[]",
            avoid_count: 0,
            start_label: "—",
            end_label: "—",
            routes_geojson: '{"type":"FeatureCollection","features":[]}',
            active_gpx: "",
            active_distance_label: "0",
            active_ascent_label: "0",
            active_descent_label: "0",
            active_duration_label: "0",
            active_energy_label: "0",
            active_warnings_count: 0,
            active_elevation_json: "{}",
            active_breakdown_json: "{}",
            request_key,
          },
        },
        ...[0, 1, 2].map((i) => ({
          op: "patch",
          entity: "route_slot",
          id: `slot-${i}`,
          row: {
            status: "empty",
            distance_m: 0,
            distance_label: "0",
            ascent_m: 0,
            ascent_label: "0",
            descent_m: 0,
            descent_label: "0",
            time_s: 0,
            duration_label: "0",
            energy_kcal: 0,
            warnings_count: 0,
          },
        })),
      ],
    };
  }

  // 6. Cycle avoid-area radius (250m -> 500m -> 1000m -> 2500m -> 5000m -> 250m)
  if (from === "btn-avoid-radius") {
    const radii = [250, 500, 1000, 2500, 5000];
    const cur = Number(planner.avoid_radius_m || 500);
    const curIdx = radii.indexOf(cur);
    const next = radii[(curIdx + 1) % radii.length];
    const avoids = safeParse(planner.avoids_json, []).map((a) => [a[0], a[1], next]);
    const avoids_json = JSON.stringify(avoids);
    const request_key = buildRequestKey(planner, slots, { a: avoids });
    return {
      updates: [{
        op: "patch",
        entity: "planner_state",
        id: "planner",
        row: {
          avoid_radius_m: next,
          avoids_json,
          request_key,
        },
      }],
    };
  }

  // 7. Clear all avoid areas
  if (from === "btn-clear-avoids") {
    const request_key = buildRequestKey(planner, slots, { a: [] });
    return {
      updates: [{
        op: "patch",
        entity: "planner_state",
        id: "planner",
        row: {
          avoids_json: "[]",
          avoid_count: 0,
          request_key,
        },
      }],
    };
  }

  // 8. Select active comparison slot (0, 1, or 2)
  if (from === "btn-select-slot" || rowId.startsWith("slot-") && from === "btn-activate-slot") {
    const slotIdx = rowId.startsWith("slot-") ? Number(rowId.slice(5)) : Number(planner.active_slot || 0);
    const targetSlot = slots.find((s) => s.id === `slot-${slotIdx}` || s.slot_index === slotIdx);
    if (!targetSlot) return { updates: [] };
    const parsedBrk = safeParse(targetSlot.breakdown_json, {});
    const parsedEle = safeParse(targetSlot.elevation_json, []);
    const device = (state.rows.device ?? [])[0];
    const units = device?.units === "imperial" ? "imperial" : "metric";
    const request_key = buildRequestKey(planner, slots, { active: slotIdx });

    return {
      updates: [
        ...[0, 1, 2].map((i) => ({
          op: "patch",
          entity: "route_slot",
          id: `slot-${i}`,
          row: { active: i === slotIdx ? "yes" : "no" },
        })),
        {
          op: "patch",
          entity: "planner_state",
          id: "planner",
          row: {
            active_slot: slotIdx,
            active_profile: targetSlot.profile,
            active_distance_label: targetSlot.distance_label,
            active_ascent_label: targetSlot.ascent_label,
            active_descent_label: targetSlot.descent_label,
            active_duration_label: targetSlot.duration_label,
            active_energy_label: `${targetSlot.energy_kcal} kcal`,
            active_warnings_count: targetSlot.warnings_count,
            active_elevation_json: JSON.stringify({
              points: parsedEle,
              ascent_m: targetSlot.ascent_m,
              descent_m: targetSlot.descent_m,
              distance_m: targetSlot.distance_m,
              units,
            }),
            active_breakdown_json: JSON.stringify({
              breakdown: parsedBrk,
              units,
            }),
            request_key,
          },
        },
      ],
    };
  }

  // 9. Change a slot's routing profile (popover picker option or select)
  if ((from === "slot-profile-select" && event.type === "change") || from.startsWith("slot-opt-")) {
    const slotIdx = rowId.startsWith("slot-") ? Number(rowId.slice(5)) : Number(planner.active_slot || 0);
    const profile = from.startsWith("slot-opt-")
      ? from.slice("slot-opt-".length)
      : String(event.value || "gabis-fast-city");
    const request_key = buildRequestKey(planner, slots, { slotProfile: { index: slotIdx, profile } });
    return {
      updates: [
        {
          op: "patch",
          entity: "route_slot",
          id: `slot-${slotIdx}`,
          row: {
            profile,
            profile_label: PROFILE_LABELS[profile] || profile,
          },
        },
        {
          op: "patch",
          entity: "planner_state",
          id: "planner",
          row: {
            ...(Number(planner.active_slot) === slotIdx ? { active_profile: profile } : {}),
            request_key,
          },
        },
      ],
    };
  }

  // 10. Cycle a slot's alternative route index (Alt 1 -> Alt 2 -> Alt 3 -> Alt 1)
  if (from === "btn-slot-alt") {
    const slotIdx = rowId.startsWith("slot-") ? Number(rowId.slice(5)) : Number(planner.active_slot || 0);
    const curSlot = slots.find((s) => s.id === `slot-${slotIdx}` || s.slot_index === slotIdx);
    const nextAlt = ((Number(curSlot?.alt || 0)) + 1) % 3;
    const request_key = buildRequestKey(planner, slots, { slotAlt: { index: slotIdx, alt: nextAlt } });
    return {
      updates: [
        {
          op: "patch",
          entity: "route_slot",
          id: `slot-${slotIdx}`,
          row: {
            alt: nextAlt,
            alt_label: `Alt ${nextAlt + 1}`,
          },
        },
        {
          op: "patch",
          entity: "planner_state",
          id: "planner",
          row: { request_key },
        },
      ],
    };
  }

  // 11. Custom .brf textarea / parameter edits + Apply Custom Profile
  if (from === "custom-brf-editor" && (event.type === "input" || event.type === "change")) {
    return {
      updates: [{
        op: "patch",
        entity: "planner_state",
        id: "planner",
        row: { custom_brf: String(event.value ?? "").slice(0, 32000) },
      }],
    };
  }

  if (from === "btn-apply-custom-brf") {
    const activeSlot = Number(planner.active_slot ?? 0);
    const request_key = buildRequestKey(planner, slots, {
      slotProfile: { index: activeSlot, profile: "custom" },
      brf: planner.custom_brf,
    });
    return {
      updates: [
        {
          op: "patch",
          entity: "route_slot",
          id: `slot-${activeSlot}`,
          row: {
            profile: "custom",
            profile_label: "profile_custom",
          },
        },
        {
          op: "patch",
          entity: "planner_state",
          id: "planner",
          row: {
            modal: "none",
            active_profile: "custom",
            request_key,
          },
        },
      ],
    };
  }

  // 12. GPX Import payload input + apply
  if (from === "gpx-import-payload" && (event.type === "input" || event.type === "change")) {
    return {
      updates: [{
        op: "patch",
        entity: "planner_state",
        id: "planner",
        row: { gpx_import_xml: String(event.value ?? "").slice(0, 60000) },
      }],
    };
  }

  if (from === "btn-apply-gpx") {
    const xml = String(planner.gpx_import_xml ?? "").trim();
    if (!xml) return { updates: [] };
    const request_key = buildRequestKey(planner, slots, {
      gpx: { xml, profile: planner.active_profile || "gabis-fast-city" },
    });
    return {
      updates: [{
        op: "patch",
        entity: "planner_state",
        id: "planner",
        row: { request_key },
      }],
    };
  }

  // 13. Offline Regional Bundle Download / Delete
  if (from === "btn-bundle-download" || from === "btn-bundle-delete") {
    const region = rowId || "sao-paulo";
    const op = from === "btn-bundle-download" ? "download" : "delete";
    const nextSeq = Number(planner.offline_seq || 0) + 1;
    const request_key = buildRequestKey(planner, slots, {
      offline: { op, region, seq: nextSeq },
    });
    return {
      updates: [
        {
          op: "patch",
          entity: "offline_bundle",
          id: region,
          row: op === "download"
            ? {
              status: "downloading",
              pmtiles_ready: "no",
            }
            : {
              status: "available",
              segments_cached: 0,
              pmtiles_ready: "no",
            },
        },
        {
          op: "patch",
          entity: "planner_state",
          id: "planner",
          row: {
            offline_seq: nextSeq,
            request_key,
          },
        },
      ],
    };
  }

  return { updates: [] };
};
