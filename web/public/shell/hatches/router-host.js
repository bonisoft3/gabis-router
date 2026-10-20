// Omnishell host-DOM hatch for GBRouter map, routing engine, and offline storage.
export default function mountRouterHost(screen, env) {
  if (typeof globalThis.__rsrouterMountHost === "function") {
    return globalThis.__rsrouterMountHost(screen, env);
  }
  return () => {};
}
