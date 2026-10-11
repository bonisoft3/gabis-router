// A small popup menu for the map. It knows nothing about routes.

export interface MenuItem {
  label: string;
  onSelect: () => void;
}

let menuEl: HTMLDivElement | null = null;
let closedAt = 0;

export function hideMenu() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  closedAt = performance.now();
}

/** True if a menu was open a moment ago. Lets the caller ignore the click that closed it. */
export function menuClosedWithin(ms: number): boolean {
  return performance.now() - closedAt < ms;
}

/** Shows a menu at viewport position (x, y). It stays inside the window. */
export function showMenu(items: MenuItem[], x: number, y: number) {
  hideMenu();
  const el = document.createElement('div');
  el.id = 'map-menu';
  el.setAttribute('role', 'menu');
  for (const item of items) {
    const button = document.createElement('button');
    button.setAttribute('role', 'menuitem');
    button.textContent = item.label;
    button.addEventListener('click', () => {
      hideMenu();
      item.onSelect();
    });
    el.appendChild(button);
  }
  document.body.appendChild(el);

  const margin = 8;
  el.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - el.offsetWidth - margin))}px`;
  el.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - el.offsetHeight - margin))}px`;
  el.querySelector('button')?.focus();
  menuEl = el;
}

// Capture phase: the map stops some events before they bubble up to the document.
document.addEventListener(
  'pointerdown',
  (e) => {
    if (menuEl && !menuEl.contains(e.target as Node)) hideMenu();
  },
  true,
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideMenu();
});
window.addEventListener('resize', hideMenu);
