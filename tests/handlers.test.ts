import { assertEquals } from "jsr:@std/assert@1";

const loadHandler = (path: string) => {
  const src = Deno.readTextFileSync(path);
  return (0, eval)(src);
};

Deno.test("is_key guard matches exact key", () => {
  const isKey = loadHandler("shell/handlers/is_key.js");
  assertEquals(isKey({}, { key: "Enter" }, { key: "Enter" }), true);
  assertEquals(isKey({}, { key: "Escape" }, { key: "Enter" }), false);
});

Deno.test("search_submitted trims search_text", () => {
  const searchSubmitted = loadHandler("shell/handlers/search_submitted.js");
  assertEquals(searchSubmitted({ items: [{ search_text: "  Hyde Park  " }] }), "Hyde Park");
  assertEquals(searchSubmitted({ items: [] }), "");
});

Deno.test("place_found unpacks PlaceAnswer rows into PlaceSuggestion rows", () => {
  const placeFound = loadHandler("shell/handlers/place_found.js");
  const state = {
    rows: {
      planner_state: [{ id: "planner", search_q: "London" }],
      place_answer: [{
        id: "search:London:en",
        kind: "search",
        q: "London",
        lang: "en",
        p0: "Trafalgar Square, London\tTrafalgar Square\tLondon\tEngland\tWC2N 5DN\tGB\t51.5072\t-0.1276\tWestminster",
        p1: "",
        p2: "",
        p3: "",
        p4: "",
      }],
      place_suggestion: [{ id: "s1" }],
    },
  };
  const res = placeFound(state, { type: "found", detail: { kind: "search", q: "London", lang: "en" } });
  assertEquals(res.updates.length, 2);
  assertEquals(res.updates[0].entity, "place_suggestion");
  assertEquals(res.updates[0].id, "s0");
  assertEquals(res.updates[0].row.label, "Trafalgar Square, London");
  assertEquals(res.updates[0].row.latitude, "51.5072");
  assertEquals(res.updates[1].op, "delete");
  assertEquals(res.updates[1].id, "s1");
});

Deno.test("planner_action reverses waypoints and recomputes request_key", () => {
  const plannerAction = loadHandler("shell/handlers/planner_action.js");
  const state = {
    rows: {
      planner_state: [{
        id: "planner",
        waypoints_json: JSON.stringify([
          [-0.1276, 51.5072, "Trafalgar Square, London"],
          [-0.0754, 51.5055, "Tower Bridge, London"],
        ]),
        avoids_json: "[]",
        active_slot: 0,
        custom_brf: "# Custom",
      }],
      route_slot: [
        { id: "slot-0", slot_index: 0, profile: "gabis-fast-city", alt: 0 },
        { id: "slot-1", slot_index: 1, profile: "gabis-safe-road", alt: 0 },
        { id: "slot-2", slot_index: 2, profile: "gabis-lite-gravel", alt: 0 },
      ],
    },
  };
  const res = plannerAction(state, { from: "btn-reverse-route" });
  assertEquals(res.updates.length, 1);
  assertEquals(res.updates[0].entity, "planner_state");
  assertEquals(res.updates[0].row.start_label, "Tower Bridge, London");
  assertEquals(res.updates[0].row.end_label, "Trafalgar Square, London");

  const pickRes = plannerAction(state, { id: "slot-0", from: "slot-opt-gravel", type: "click" });
  assertEquals(pickRes.updates.length, 2);
  assertEquals(pickRes.updates[0].entity, "route_slot");
  assertEquals(pickRes.updates[0].id, "slot-0");
  assertEquals(pickRes.updates[0].row.profile, "gravel");
  assertEquals(pickRes.updates[0].row.profile_label, "profile_gravel");
  assertEquals(pickRes.updates[1].row.active_profile, "gravel");

  // Sidebar waypoint removal + 1-waypoint guard on btn-remove-end
  const singleWpState = {
    rows: {
      ...state.rows,
      planner_state: [{
        ...state.rows.planner_state[0],
        waypoints_json: JSON.stringify([[-0.1276, 51.5072, "Trafalgar Square, London"]]),
      }],
    },
  };
  assertEquals(plannerAction(singleWpState, { from: "btn-remove-end" }).updates.length, 0);
  const removeStartRes = plannerAction(singleWpState, { from: "btn-remove-start" });
  assertEquals(removeStartRes.updates[0].row.waypoint_count, 0);
  assertEquals(removeStartRes.updates[0].row.active_gpx, "");

  // Custom .brf, avoid radius cycling, GPX import, and offline bundle actions
  const brfRes = plannerAction(state, { from: "btn-apply-custom-brf" });
  assertEquals(brfRes.updates.some((u: { entity: string }) => u.entity === "route_slot"), true);
  const radRes = plannerAction(state, { from: "btn-avoid-radius" });
  assertEquals(radRes.updates[0].row.avoid_radius_m, 1000);
  const gpxState = {
    rows: {
      ...state.rows,
      planner_state: [{ ...state.rows.planner_state[0], gpx_import_xml: "<gpx><trkpt lat=\"51.5\" lon=\"-0.1\"/></gpx>" }],
      offline_bundle: [{ id: "london", title: "London", segments_cached: 0, status: "available" }],
    },
  };
  const gpxRes = plannerAction(gpxState, { from: "btn-apply-gpx" });
  assertEquals(gpxRes.updates[0].row.request_key.includes('"gpx":'), true);
  const dlRes = plannerAction(gpxState, { id: "london", from: "btn-bundle-download" });
  assertEquals(dlRes.updates[0].row.status, "downloading");
  assertEquals(dlRes.updates[0].row.pmtiles_ready, "no");
  assertEquals(dlRes.updates[1].row.offline_seq, 1);
  const delBundleRes = plannerAction(gpxState, { id: "london", from: "btn-bundle-delete" });
  assertEquals(delBundleRes.updates[0].row.status, "available");
  assertEquals(delBundleRes.updates[1].row.offline_seq, 1);
});

Deno.test("map_action handles add_waypoint and inspect_point", () => {
  const mapAction = loadHandler("shell/handlers/map_action.js");
  const state = {
    rows: {
      planner_state: [{
        id: "planner",
        waypoints_json: JSON.stringify([[-0.1276, 51.5072, "Start"]]),
        avoids_json: "[]",
        avoid_radius_m: 500,
        active_slot: 0,
        custom_brf: "# Custom",
      }],
      route_slot: [
        { id: "slot-0", slot_index: 0, profile: "gabis-fast-city", alt: 0 },
        { id: "slot-1", slot_index: 1, profile: "gabis-safe-road", alt: 0 },
        { id: "slot-2", slot_index: 2, profile: "gabis-lite-gravel", alt: 0 },
      ],
    },
  };
  const resAdd = mapAction(state, {
    type: "map_action",
    detail: { action: "add_waypoint", lon: "-0.07540", lat: "51.50550", index: -1, label: "" },
  });
  assertEquals(resAdd.updates.length, 1);
  assertEquals(resAdd.updates[0].row.waypoint_count, 2);

  const resInspect = mapAction(state, {
    type: "map_action",
    detail: { action: "inspect_point", lon: "-0.10000", lat: "51.50000", index: -1, label: "" },
  });
  assertEquals(resInspect.updates.length, 1);
  assertEquals(resInspect.updates[0].row.request_key.includes('"ins":[-0.1,51.5]'), true);

  const stateTwo = {
    rows: {
      ...state.rows,
      planner_state: [{
        ...state.rows.planner_state[0],
        waypoints_json: JSON.stringify([
          [-0.1276, 51.5072, "Start"],
          [-0.0754, 51.5055, "End"],
        ]),
      }],
    },
  };
  const resVia = mapAction(stateTwo, {
    type: "map_action",
    detail: { action: "add_via", lon: "-0.10150", lat: "51.50900", index: 1, label: "Via St Pauls" },
  });
  assertEquals(resVia.updates[0].row.waypoint_count, 3);
  const parsedVia = JSON.parse(resVia.updates[0].row.waypoints_json);
  assertEquals(parsedVia[1][2], "Via St Pauls");

  const resDel = mapAction({
    rows: {
      ...stateTwo.rows,
      planner_state: [{
        ...stateTwo.rows.planner_state[0],
        waypoints_json: resVia.updates[0].row.waypoints_json,
      }],
    },
  }, {
    type: "map_action",
    detail: { action: "delete_waypoint", lon: "0", lat: "0", index: 1, label: "" },
  });
  assertEquals(resDel.updates[0].row.waypoint_count, 2);
});

Deno.test("route_answered folds RouteAnswer and supports unit-toggle mutation without undeclared fields", () => {
  const routeAnswered = loadHandler("shell/handlers/route_answered.js");
  const slot0 = {
    profile: "gabis-fast-city",
    alt: 0,
    distance_m: 4800,
    ascent_m: 34,
    descent_m: 31,
    time_s: 960,
    energy_kcal: 112,
    elevation: [[0, 14, 0], [2.4, 24, 1.8], [4.8, 16, -0.5]],
    breakdown: { surface: [{ label: "Asphalt", distance_m: 3600, pct: 75 }], warnings: [] },
  };
  const state = {
    rows: {
      device: [{ id: "device", theme: "auto", units: "metric" }],
      planner_state: [{
        id: "planner",
        request_key: "req-1",
        active_slot: 0,
        waypoints_json: JSON.stringify([[-0.1276, 51.5072, "Trafalgar Square"], [-0.0754, 51.5055, "Tower Bridge"]]),
      }],
      route_slot: [
        { id: "slot-0", slot_index: 0, profile: "gabis-fast-city", alt: 0, distance_m: 4800, ascent_m: 34, descent_m: 31, time_s: 960, energy_kcal: 112, elevation_json: "[]", breakdown_json: "{}" },
      ],
      offline_bundle: [
        { id: "sao-paulo", status: "available", segments_cached: 0, pmtiles_ready: "no" },
      ],
      route_answer: [{
        id: "ans-1",
        request_key: "req-1",
        slot_0_json: JSON.stringify(slot0),
        slot_1_json: JSON.stringify(slot0),
        slot_2_json: JSON.stringify(slot0),
        routes_geojson: '{"type":"FeatureCollection","features":[]}',
        active_gpx: "<gpx></gpx>",
        inspect_json: "{}",
        matched_waypoints_json: "[]",
        offline_json: JSON.stringify({ "sao-paulo": { status: "installed", segments_cached: 1, pmtiles_ready: "yes" } }),
      }],
    },
  };
  const res = routeAnswered(state, { type: "routed", detail: { request_key: "req-1" } });
  const slotUpdate = res.updates.find((u: { entity: string; id: string }) => u.entity === "route_slot" && u.id === "slot-0");
  assertEquals("engine" in slotUpdate.row, false);
  assertEquals(slotUpdate.row.distance_label, "4.8 km");

  const bundleUpdate = res.updates.find((u: { entity: string; id: string }) => u.entity === "offline_bundle" && u.id === "sao-paulo");
  assertEquals(bundleUpdate.row.segments_cached, 1);

  const plannerUpdate = res.updates.find((u: { entity: string }) => u.entity === "planner_state");
  assertEquals(
    plannerUpdate.row.inspect_summary,
    "Right-click map -> Inspect road segment to view OSM tags and cost factors.",
  );

  // Inspect response includes OpenStreetMap direct URL
  const inspectAnsState = {
    rows: {
      ...state.rows,
      route_answer: [{
        ...state.rows.route_answer[0],
        inspect_json: JSON.stringify({
          lon: -0.1276,
          lat: 51.5072,
          distance_m: 4,
          tags: [{ key: "highway", value: "cycleway" }],
        }),
      }],
    },
  };
  const inspectRes = routeAnswered(inspectAnsState, { type: "routed", detail: { request_key: "req-1" } });
  const inspectPlanner = inspectRes.updates.find((u: { entity: string }) => u.entity === "planner_state");
  assertEquals(inspectPlanner.row.inspect_summary.includes("https://www.openstreetmap.org/#map=18/51.5072/-0.1276"), true);

  // Unit toggle mutation when route_answer is empty
  const impState = {
    rows: {
      ...state.rows,
      device: [{ id: "device", theme: "auto", units: "imperial" }],
      route_answer: [],
    },
  };
  const impRes = routeAnswered(impState, { type: "mutation" });
  const impPlanner = impRes.updates.find((u: { entity: string }) => u.entity === "planner_state");
  assertEquals(impPlanner.row.active_distance_label, "3.0 mi");
  assertEquals(impPlanner.row.active_ascent_label, "112 ft");
});

Deno.test("elevation-chart and surface-breakdown renderers produce VDOM trees", () => {
  const renderElevation = loadHandler("shell/renderers/elevation-chart.js");
  const svgTree = renderElevation(
    `${JSON.stringify({
      points: [[0, 14, 0], [2.4, 24, 1.8], [4.8, 16, -0.5]],
      ascent_m: 34,
      descent_m: 31,
      distance_m: 4800,
      units: "metric",
    })}\t500`,
  );
  assertEquals(Array.isArray(svgTree), true);
  assertEquals(svgTree[0].tag, "div");
  assertEquals(JSON.stringify(svgTree).includes("svg"), true);

  const renderBreakdown = loadHandler("shell/renderers/surface-breakdown.js");
  const htmlTree = renderBreakdown(
    `${JSON.stringify({
      breakdown: {
        surface: [{ label: "Asphalt", color: "#10b981", distance_m: 3600, pct: 75, ranges: [[0, 12]] }],
        segments_by_tab: {
          surface: [{ label: "Asphalt", color: "#10b981", distance_m: 3600, from_m: 0, to_m: 3600, range: [0, 12] }],
        },
      },
      units: "metric",
    })}\tsurface`,
  );
  assertEquals(Array.isArray(htmlTree), true);
  const serializedBrk = JSON.stringify(htmlTree);
  assertEquals(serializedBrk.includes("Asphalt"), true);
  assertEquals(serializedBrk.includes("75%"), true);
  assertEquals(serializedBrk.includes("breakdown-svg-bar"), true);
  assertEquals(serializedBrk.includes("seg-idx-0"), true);
  assertEquals(serializedBrk.includes("cat-idx-0"), true);

  const warnTree = renderBreakdown(
    `${JSON.stringify({
      breakdown: {
        warnings: [{ label: "Steps", distance_m: 45, count: 2, ranges: [[3, 5]] }],
      },
      units: "metric",
    })}\twarnings`,
  );
  const serializedWarn = JSON.stringify(warnTree);
  assertEquals(serializedWarn.includes("Steps"), true);
  assertEquals(serializedWarn.includes("warn-idx-0"), true);
});

Deno.test("offline bundle lifecycle transitions downloading -> installed/error -> available with unique request_keys", () => {
  const plannerAction = loadHandler("shell/handlers/planner_action.js");
  const routeAnswered = loadHandler("shell/handlers/route_answered.js");
  const baseState = {
    rows: {
      device: [{ id: "device", theme: "auto", units: "metric" }],
      planner_state: [{
        id: "planner",
        waypoints_json: JSON.stringify([[-0.1276, 51.5072, "A"], [-0.0754, 51.5055, "B"]]),
        avoids_json: "[]",
        active_slot: 0,
        offline_seq: 0,
      }],
      route_slot: [{ id: "slot-0", slot_index: 0, profile: "gabis-fast-city", alt: 0, distance_m: 1000, ascent_m: 10, descent_m: 10, time_s: 200, energy_kcal: 30, elevation_json: "[]", breakdown_json: "{}" }],
      offline_bundle: [{ id: "scotland", status: "available", segments_cached: 0, pmtiles_ready: "no" }],
      route_answer: [],
    },
  };

  // Click "Baixar Pacote" -> transitions immediately to "downloading", NOT "installed"
  const dl1 = plannerAction(baseState, { from: "btn-bundle-download", id: "scotland", type: "click" });
  const dl1Bundle = dl1.updates.find((u: { entity: string }) => u.entity === "offline_bundle");
  const dl1Planner = dl1.updates.find((u: { entity: string }) => u.entity === "planner_state");
  assertEquals(dl1Bundle.row.status, "downloading");
  assertEquals(dl1Bundle.row.pmtiles_ready, "no");
  assertEquals(dl1Planner.row.offline_seq, 1);

  // Worker completes download -> route_answered folds "installed"
  const afterDlState = {
    rows: {
      ...baseState.rows,
      planner_state: [{ ...baseState.rows.planner_state[0], ...dl1Planner.row }],
      offline_bundle: [{ id: "scotland", ...dl1Bundle.row }],
      route_answer: [{
        id: "ans-dl",
        request_key: dl1Planner.row.request_key,
        slot_0_json: JSON.stringify({ profile: "gabis-fast-city", alt: 0, distance_m: 1000, ascent_m: 10, descent_m: 10, time_s: 200, energy_kcal: 30, elevation: [], breakdown: { route_coords: Array.from({ length: 250 }, (_, i) => [-0.1 + i * 0.0001, 51.5]) } }),
        slot_1_json: "{}",
        slot_2_json: "{}",
        routes_geojson: '{"type":"FeatureCollection","features":[]}',
        active_gpx: "<gpx></gpx>",
        inspect_json: "{}",
        matched_waypoints_json: "[]",
        offline_json: JSON.stringify({ scotland: { status: "installed", segments_cached: 2, pmtiles_ready: "yes" } }),
      }],
    },
  };
  const foldedInstalled = routeAnswered(afterDlState, { type: "routed", detail: { request_key: dl1Planner.row.request_key } });
  const installedBundle = foldedInstalled.updates.find((u: { entity: string }) => u.entity === "offline_bundle");
  assertEquals(installedBundle.row.status, "installed");
  assertEquals(installedBundle.row.segments_cached, 2);
  assertEquals(installedBundle.row.pmtiles_ready, "yes");

  // Serialized breakdown_json and active_breakdown_json remain valid parseable JSON (never sliced mid-token)
  const foldedSlot = foldedInstalled.updates.find((u: { entity: string }) => u.entity === "route_slot");
  assertEquals(Array.isArray(JSON.parse(foldedSlot.row.breakdown_json).route_coords), true);

  // Delete + re-download produces strictly distinct request_keys so RouteAnswer memoization never collides
  const delState = {
    rows: {
      ...afterDlState.rows,
      offline_bundle: [{ id: "scotland", ...installedBundle.row }],
    },
  };
  const delRes = plannerAction(delState, { from: "btn-bundle-delete", id: "scotland", type: "click" });
  const delPlanner = delRes.updates.find((u: { entity: string }) => u.entity === "planner_state");
  assertEquals(delPlanner.row.offline_seq, 2);

  const dl2State = {
    rows: {
      ...delState.rows,
      planner_state: [{ ...delState.rows.planner_state[0], ...delPlanner.row }],
      offline_bundle: [{ id: "scotland", status: "available", segments_cached: 0, pmtiles_ready: "no" }],
    },
  };
  const dl2 = plannerAction(dl2State, { from: "btn-bundle-download", id: "scotland", type: "click" });
  const dl2Planner = dl2.updates.find((u: { entity: string }) => u.entity === "planner_state");
  assertEquals(dl2Planner.row.offline_seq, 3);
  assertEquals(dl2Planner.row.request_key !== dl1Planner.row.request_key, true);

  // Worker reports download failure -> route_answered transitions to "error"
  const errFold = routeAnswered({
    rows: {
      ...dl2State.rows,
      planner_state: [{ ...dl2State.rows.planner_state[0], ...dl2Planner.row }],
      offline_bundle: [{ id: "scotland", status: "downloading", segments_cached: 0, pmtiles_ready: "no" }],
      route_answer: [{
        ...afterDlState.rows.route_answer[0],
        request_key: dl2Planner.row.request_key,
        offline_json: JSON.stringify({ scotland: { status: "error", segments_cached: 0, pmtiles_ready: "no" } }),
      }],
    },
  }, { type: "routed", detail: { request_key: dl2Planner.row.request_key } });
  const errBundle = errFold.updates.find((u: { entity: string }) => u.entity === "offline_bundle");
  assertEquals(errBundle.row.status, "error");

  // CSS and map unit regression guards
  const css = Deno.readTextFileSync(new URL("../shell/screens/router.css", import.meta.url));
  assertEquals(css.includes('.bundle-card[data-bundle-status="downloading"] #btn-bundle-download'), true);
  assertEquals(css.includes('.bundle-card[data-bundle-status="installed"] #btn-bundle-download'), true);
  assertEquals(css.includes('.bundle-card[data-bundle-status="available"] #btn-bundle-delete'), true);
  assertEquals(css.includes("grid-template-columns: repeat(2, minmax(148px, 1fr))"), true);
  assertEquals(css.includes("--shadow-md"), false);

  const mapHtml = Deno.readTextFileSync(new URL("../shell/units/router-map/index.html", import.meta.url));
  assertEquals(mapHtml.includes(".ctx-item[hidden]"), true);
});
