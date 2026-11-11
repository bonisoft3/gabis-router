// route_answered — folds a RouteAnswer from shell/units/brouter/unit.js into
// RouteSlot rows ("slot-0".."slot-2"), OfflineBundle rows, and PlannerState.
const SLOT_IDS = ["slot-0", "slot-1", "slot-2"];
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

const safeParse = (raw, fallback) => {
  if (!raw || typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
};

const formatDuration = (seconds) => {
  const s = Math.max(0, Math.round(Number(seconds || 0)));
  const hrs = Math.floor(s / 3600);
  const mins = Math.max(s > 0 ? 1 : 0, Math.round((s % 3600) / 60));
  return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
};

const formatDist = (meters, units) => {
  const m = Math.max(0, Number(meters || 0));
  if (units === "imperial") {
    return `${(m / 1609.344).toFixed(1)} mi`;
  }
  return `${(m / 1000).toFixed(1)} km`;
};

const formatEle = (meters, units) => {
  const m = Math.max(0, Math.round(Number(meters || 0)));
  if (units === "imperial") {
    return `${Math.round(m * 3.28084)} ft`;
  }
  return `${m} m`;
};

(state, event) => {
  if (event.type !== "routed" && event.type !== "mutation") return { updates: [] };
  const planner = (state.rows.planner_state ?? [])[0];
  if (!planner) return { updates: [] };

  const device = (state.rows.device ?? [])[0];
  const units = device?.units === "imperial" ? "imperial" : "metric";
  const activeSlot = Number(planner.active_slot ?? 0);

  if (event.type === "mutation") {
    const existingSlots = state.rows.route_slot ?? [];
    if (existingSlots.length === 0) return { updates: [] };
    const curSlot = existingSlots.find((s) => s.slot_index === activeSlot || s.id === `slot-${activeSlot}`) ?? existingSlots[0];
    const wantActiveDist = formatDist(curSlot.distance_m, units);
    const wantActiveAsc = formatEle(curSlot.ascent_m, units);
    if (planner.active_distance_label === wantActiveDist && planner.active_ascent_label === wantActiveAsc) {
      return { updates: [] };
    }
    const slotUpdates = existingSlots.map((s) => ({
      op: "patch",
      entity: "route_slot",
      id: s.id,
      row: {
        distance_label: formatDist(s.distance_m, units),
        ascent_label: formatEle(s.ascent_m, units),
        descent_label: formatEle(s.descent_m, units),
        duration_label: formatDuration(s.time_s),
      },
    }));
    const parsedEle = safeParse(curSlot.elevation_json, []);
    const parsedBrk = safeParse(curSlot.breakdown_json, {});
    return {
      updates: [
        ...slotUpdates,
        {
          op: "patch",
          entity: "planner_state",
          id: "planner",
          row: {
            active_distance_label: wantActiveDist,
            active_ascent_label: wantActiveAsc,
            active_descent_label: formatEle(curSlot.descent_m, units),
            active_duration_label: formatDuration(curSlot.time_s),
            active_energy_label: `${Math.round(Number(curSlot.energy_kcal || 0))} kcal`,
            active_elevation_json: JSON.stringify({
              points: parsedEle,
              ascent_m: curSlot.ascent_m,
              descent_m: curSlot.descent_m,
              distance_m: curSlot.distance_m,
              units,
            }),
            active_breakdown_json: JSON.stringify({
              breakdown: parsedBrk,
              units,
            }),
          },
        },
      ],
    };
  }

  const requestKey = event.detail?.request_key ?? "";
  if (!requestKey || planner.request_key !== requestKey) return { updates: [] };

  const answer = (state.rows.route_answer ?? []).find((a) => a.request_key === requestKey) ?? event.detail;
  if (!answer || !answer.slot_0_json) return { updates: [] };

  const rawSlots = [
    safeParse(answer.slot_0_json, null),
    safeParse(answer.slot_1_json, null),
    safeParse(answer.slot_2_json, null),
  ];

  const updates = [];

  for (let i = 0; i < 3; i++) {
    const id = SLOT_IDS[i];
    const existing = (state.rows.route_slot ?? []).find((r) => r.id === id);
    const s = rawSlots[i];
    const profile = s?.profile || existing?.profile || (i === 0 ? "gabis-fast-city" : i === 1 ? "gabis-safe-road" : "gabis-lite-gravel");
    const altIdx = Number(s?.alt ?? existing?.alt ?? 0);
    const distM = Math.round(Number(s?.distance_m ?? 0));
    const ascM = Math.round(Number(s?.ascent_m ?? 0));
    const descM = Math.round(Number(s?.descent_m ?? 0));
    const timeS = Math.round(Number(s?.time_s ?? 0));
    const kcal = Math.round(Number(s?.energy_kcal ?? 0));
    const elevationArr = Array.isArray(s?.elevation) ? s.elevation : [];
    const breakdownObj = s?.breakdown && typeof s.breakdown === "object" ? s.breakdown : {};
    const warningsCount = Array.isArray(breakdownObj.warnings) ? breakdownObj.warnings.length : 0;

    updates.push({
      op: "put",
      entity: "route_slot",
      id,
      row: {
        slot_index: i,
        active: i === activeSlot ? "yes" : "no",
        profile,
        profile_label: PROFILE_LABELS[profile] || profile,
        alt: altIdx,
        alt_label: `Alt ${altIdx + 1}`,
        status: distM > 0 ? "ready" : "empty",
        distance_m: distM,
        distance_label: formatDist(distM, units),
        ascent_m: ascM,
        ascent_label: formatEle(ascM, units),
        descent_m: descM,
        descent_label: formatEle(descM, units),
        time_s: timeS,
        duration_label: formatDuration(timeS),
        energy_kcal: kcal,
        warnings_count: warningsCount,
        elevation_json: JSON.stringify(elevationArr),
        breakdown_json: JSON.stringify(breakdownObj),
      },
    });
  }

  const activeData = rawSlots[activeSlot] || rawSlots[0] || {};
  const activeBreakdown = activeData.breakdown || {};
  const activeElevation = Array.isArray(activeData.elevation) ? activeData.elevation : [];
  const matchedWps = safeParse(answer.matched_waypoints_json, []);
  const inspectObj = safeParse(answer.inspect_json, {});
  const inspectTags = Array.isArray(inspectObj?.tags) ? inspectObj.tags : [];
  const inspectSummary = inspectTags.length > 0
    ? `${inspectObj.lat}, ${inspectObj.lon} (${inspectObj.distance_m}m) · ` +
      inspectTags.map((t) => `${t.key}=${t.value}`).join(" · ") +
      ` · https://www.openstreetmap.org/#map=18/${inspectObj.lat}/${inspectObj.lon}`
    : (planner.inspect_summary || "Right-click map -> Inspect road segment to view OSM tags and cost factors.");

  const bundlesMap = safeParse(answer.offline_json, {});
  for (const existingBundle of state.rows.offline_bundle ?? []) {
    const updated = bundlesMap[existingBundle.id];
    if (updated) {
      const nextStatus = updated.status === "error" ? "error" : "installed";
      updates.push({
        op: "patch",
        entity: "offline_bundle",
        id: existingBundle.id,
        row: {
          status: nextStatus,
          segments_cached: Number(updated.segments_cached ?? updated.segments_ready ?? existingBundle.segments_cached ?? 0),
          pmtiles_ready: nextStatus === "installed" ? String(updated.pmtiles_ready || "yes") : "no",
        },
      });
    } else if (existingBundle.status === "installed" || existingBundle.status === "downloading") {
      updates.push({
        op: "patch",
        entity: "offline_bundle",
        id: existingBundle.id,
        row: {
          status: "available",
          segments_cached: 0,
          pmtiles_ready: "no",
        },
      });
    }
  }

  const nextWaypointsJson = Array.isArray(matchedWps) && matchedWps.length >= 2
    ? JSON.stringify(matchedWps)
    : planner.waypoints_json;
  const parsedWps = safeParse(nextWaypointsJson, []);

  updates.push({
    op: "patch",
    entity: "planner_state",
    id: "planner",
    row: {
      waypoints_json: nextWaypointsJson,
      waypoint_count: parsedWps.length,
      start_label: parsedWps[0]?.[2] || (parsedWps[0] ? `${parsedWps[0][1]}, ${parsedWps[0][0]}` : "—"),
      end_label: parsedWps.length >= 2
        ? (parsedWps[parsedWps.length - 1]?.[2] || `${parsedWps[parsedWps.length - 1][1]}, ${parsedWps[parsedWps.length - 1][0]}`)
        : "—",
      routes_geojson: String(answer.routes_geojson || '{"type":"FeatureCollection","features":[]}'),
      active_gpx: String(answer.active_gpx || ""),
      active_profile: String(activeData.profile || planner.active_profile || "gabis-fast-city"),
      active_distance_label: formatDist(activeData.distance_m || 0, units),
      active_ascent_label: formatEle(activeData.ascent_m || 0, units),
      active_descent_label: formatEle(activeData.descent_m || 0, units),
      active_duration_label: formatDuration(activeData.time_s || 0),
      active_energy_label: `${Math.round(Number(activeData.energy_kcal || 0))} kcal`,
      active_warnings_count: Array.isArray(activeBreakdown.warnings) ? activeBreakdown.warnings.length : 0,
      active_elevation_json: JSON.stringify({
        points: activeElevation,
        ascent_m: Math.round(Number(activeData.ascent_m || 0)),
        descent_m: Math.round(Number(activeData.descent_m || 0)),
        distance_m: Math.round(Number(activeData.distance_m || 0)),
        units,
      }),
      active_breakdown_json: JSON.stringify({
        breakdown: activeBreakdown,
        units,
      }),
      inspect_summary: inspectSummary,
    },
  });

  return { updates };
};
