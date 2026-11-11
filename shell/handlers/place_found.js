// place_found — populates PlaceSuggestion rows from the memoised PlaceAnswer
// matching the current PlannerState.search_q.
const SEARCH_IDS = ["s0", "s1", "s2", "s3", "s4"];
const FIELDS = ["label", "line1", "city", "region", "postal_code", "country", "latitude", "longitude", "district"];
const placeOf = (column) => {
  const cells = String(column ?? "").split("\t");
  return Object.fromEntries(FIELDS.map((f, i) => [f, cells[i] ?? ""]));
};

(state, event) => {
  if (event.type !== "found") return { updates: [] };
  const { kind, q, lang } = event.detail ?? {};
  if (kind !== "search" || !q) return { updates: [] };
  const planner = (state.rows.planner_state ?? [])[0];
  if (!planner || planner.search_q !== q) return { updates: [] };
  const answer = (state.rows.place_answer ?? []).find((a) => a.kind === "search" && a.q === q && a.lang === lang);
  if (!answer) return { updates: [] };
  const places = [answer.p0, answer.p1, answer.p2, answer.p3, answer.p4]
    .filter((p) => typeof p === "string" && p !== "")
    .map(placeOf)
    .filter((p) => p.latitude !== "" && p.longitude !== "");
  const shown = new Set((state.rows.place_suggestion ?? []).map((s) => s.id));
  return {
    updates: SEARCH_IDS.flatMap((id, i) =>
      i < places.length
        ? [{
          op: "put",
          entity: "place_suggestion",
          id,
          row: {
            label: places[i].label || places[i].line1 || `${places[i].latitude}, ${places[i].longitude}`,
            line1: places[i].line1 || places[i].label,
            district: places[i].district || "",
            city: places[i].city || places[i].region || places[i].country,
            region: places[i].region || "",
            postal_code: places[i].postal_code || "",
            country: places[i].country || "",
            latitude: places[i].latitude,
            longitude: places[i].longitude,
            q,
          },
        }]
        : shown.has(id)
        ? [{ op: "delete", entity: "place_suggestion", id }]
        : []
    ),
  };
};
