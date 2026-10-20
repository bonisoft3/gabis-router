import "@omnishell/vendor/ses.umd.min.js";
import { createShell } from "@omnishell/shell.js";
import { installRouterHost } from "./pronto/host";
import "./style.css";

// Keep Object constructor extensible for MapLibre GL worker class registration
// while evaluating Jessie handlers and renderers inside SES Compartments.
(globalThis as any).__prontoLockdown = true;
(globalThis as any).harden ??= (x: any) => x;

installRouterHost();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root mount element");
root.innerHTML = "";

createShell({
  config: "/shell/shell.json",
  mount: root,
  preload: false,
});

if (import.meta.hot) {
  import.meta.hot.accept();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}
