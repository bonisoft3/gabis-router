// The Settings section of the panel.

import { getUnits, setUnits, type Units } from './format.ts';
import { getTheme, onThemeChange, setTheme, type Theme } from './theme.ts';
import { setThunderforestKey } from './basemap.ts';

const unitsSelect = document.getElementById('select-units') as HTMLSelectElement;
const themeSelect = document.getElementById('select-theme') as HTMLSelectElement;
const thunderforestKeyInput = document.getElementById('input-thunderforest-key') as HTMLInputElement | null;

unitsSelect.value = getUnits();
themeSelect.value = getTheme();
unitsSelect.addEventListener('change', () => setUnits(unitsSelect.value as Units));
themeSelect.addEventListener('change', () => setTheme(themeSelect.value as Theme));

onThemeChange(() => {
  const current = getTheme();
  if (themeSelect.value !== current) {
    themeSelect.value = current;
  }
});

if (thunderforestKeyInput) {
  thunderforestKeyInput.value = localStorage.getItem('rsrouter_thunderforest_key') || '';
  thunderforestKeyInput.placeholder = 'Default key active';
  thunderforestKeyInput.addEventListener('change', () => {
    setThunderforestKey(thunderforestKeyInput.value);
  });
}
