// UI theme setting: follows the device color scheme, or locks to light or dark.

export type Theme = 'auto' | 'light' | 'dark';
export type ThemeSetting = Theme;

const STORAGE_KEY = 'rsrouter_theme';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const listeners: Array<() => void> = [];

let setting: Theme =
  (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? 'auto';

export function getTheme(): Theme {
  return setting;
}

export const getThemeSetting = getTheme;

/** The theme in use right now for UI elements, after resolving "auto". */
export function isDark(): boolean {
  if (setting === 'dark') return true;
  if (setting === 'light') return false;
  return darkQuery.matches;
}

function apply() {
  document.documentElement.dataset.theme = isDark() ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark() ? '#0f172a' : '#1e293b');
  listeners.forEach((fn) => fn());
}

export function setTheme(next: Theme) {
  if (setting === next) return;
  setting = next;
  localStorage.setItem(STORAGE_KEY, next);
  apply();
}

export const setThemeSetting = setTheme;

/** Calls `fn` after the resolved theme has changed. */
export function onThemeChange(fn: () => void) {
  listeners.push(fn);
}

darkQuery.addEventListener('change', () => {
  if (setting === 'auto') {
    apply();
  }
});

// Set the attribute right away so the first paint already has the right colours.
document.documentElement.dataset.theme = isDark() ? 'dark' : 'light';
