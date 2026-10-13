import { useState, useEffect, useCallback } from 'react';
import { getUnits, setUnits as setFormatUnits, onUnitsChange, type Units } from '../format.ts';
import { getTheme, setTheme as setGlobalTheme, onThemeChange, type Theme } from '../theme.ts';
import {
  getBasemap,
  setBasemap as setGlobalBasemap,
  onBasemapChange,
  getThunderforestKey,
  setThunderforestKey as setGlobalThunderforestKey,
  type Basemap,
} from '../basemap.ts';

export function useSettings() {
  const [units, setUnitsState] = useState<Units>(() => getUnits());
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  const [basemap, setBasemapState] = useState<Basemap>(() => getBasemap());
  const [thunderforestKey, setThunderforestKeyState] = useState<string>(() => getThunderforestKey());

  useEffect(() => {
    onUnitsChange(() => setUnitsState(getUnits()));
    onThemeChange(() => setThemeState(getTheme()));
    onBasemapChange(() => {
      setBasemapState(getBasemap());
      setThunderforestKeyState(getThunderforestKey());
    });
  }, []);

  const changeUnits = useCallback((next: Units) => {
    setFormatUnits(next);
    setUnitsState(next);
  }, []);

  const changeTheme = useCallback((next: Theme) => {
    setGlobalTheme(next);
    setThemeState(next);
  }, []);

  const changeBasemap = useCallback((next: Basemap) => {
    setGlobalBasemap(next);
    setBasemapState(next);
  }, []);

  const changeThunderforestKey = useCallback((nextKey: string) => {
    setGlobalThunderforestKey(nextKey);
    setThunderforestKeyState(getThunderforestKey());
  }, []);

  return {
    units,
    changeUnits,
    theme,
    changeTheme,
    basemap,
    changeBasemap,
    thunderforestKey,
    changeThunderforestKey,
  };
}
