// A small popup menu for the map. It knows nothing about routes.

export interface MenuItem {
  label: string;
  hint?: string;
  danger?: boolean;
  dividerBefore?: boolean;
  active?: boolean;
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
export function showMenu(items: MenuItem[], x: number, y: number, headerText?: string) {
  hideMenu();
  const el = document.createElement('div');
  el.id = 'map-menu';
  el.setAttribute('role', 'menu');

  if (headerText) {
    const hdr = document.createElement('div');
    hdr.className = 'map-menu-header';
    hdr.textContent = headerText;
    el.appendChild(hdr);
  }

  for (const item of items) {
    if (item.dividerBefore) {
      const div = document.createElement('div');
      div.className = 'map-menu-divider';
      el.appendChild(div);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    if (item.danger) button.classList.add('map-menu-item-danger');
    if (item.active) button.classList.add('map-menu-item-active');

    const labelSpan = document.createElement('span');
    labelSpan.textContent = item.label;
    button.appendChild(labelSpan);

    if (item.hint) {
      const hintSpan = document.createElement('small');
      hintSpan.className = 'map-menu-hint';
      hintSpan.textContent = item.hint;
      button.appendChild(hintSpan);
    }

    button.addEventListener('click', () => {
      hideMenu();
      item.onSelect();
    });
    el.appendChild(button);
  }
  document.body.appendChild(el);

  const margin = 10;
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
  if (!menuEl) return;
  if (e.key === 'Escape') {
    hideMenu();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const buttons = Array.from(menuEl.querySelectorAll<HTMLButtonElement>('button'));
    if (buttons.length === 0) return;
    e.preventDefault();
    const cur = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowDown'
        ? (cur + 1) % buttons.length
        : (cur - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
});
window.addEventListener('resize', hideMenu);

