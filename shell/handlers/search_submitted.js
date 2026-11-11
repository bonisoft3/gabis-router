// search_submitted — copies the typed search_text into search_q only when the
// reader explicitly submits, respecting Nominatim's 1 req/s rate policy.
(state) => {
  const planner = (state.items ?? [])[0];
  return (planner?.search_text ?? "").trim();
};
