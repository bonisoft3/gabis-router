// Photon-based geocoding and reverse geocoding for online mode.

export interface GeocodePlace {
  lat: number;
  lon: number;
  title: string;
  subtitle: string;
  name: string;
}

const reverseCache = new Map<string, string>();
let searchAbortController: AbortController | null = null;

export function isOnlineMode(): boolean {
  try {
    const offlinePref = typeof localStorage !== 'undefined' ? localStorage.getItem('rsrouter_offline_mode') : null;
    const navOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    return offlinePref !== 'true' && navOnline;
  } catch {
    return false;
  }
}

function coordKey(lat: number, lon: number): string {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

export function formatPlaceProperties(props: Record<string, any>): { title: string; subtitle: string; name: string } {
  let title = '';
  if (props.osm_value === 'postcode' && props.city) {
    title = props.name ? `${props.city} (${props.name})` : props.city;
  } else if (props.name) {
    if (props.housenumber && props.street && props.name === props.housenumber) {
      title = `${props.housenumber} ${props.street}`;
    } else {
      title = props.name;
    }
  } else if (props.street) {
    title = props.housenumber ? `${props.housenumber} ${props.street}` : props.street;
  } else {
    title = props.district || props.city || props.county || props.country || '';
  }

  const subtitleParts: string[] = [];
  const lowerTitle = title.toLowerCase();

  for (const key of ['street', 'district', 'city', 'county', 'state', 'country']) {
    const val = props[key];
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (lowerTitle.includes(lower)) continue;
      if (subtitleParts.some((p) => p.toLowerCase() === lower)) continue;
      subtitleParts.push(trimmed);
    }
  }

  const subtitle = subtitleParts.join(', ');

  let name = title || 'Point';
  if (props.osm_value !== 'postcode') {
    const contextCandidates = [props.district, props.city, props.county];
    for (const cand of contextCandidates) {
      if (typeof cand === 'string' && cand.trim()) {
        const trimmed = cand.trim();
        if (!name.toLowerCase().includes(trimmed.toLowerCase())) {
          name = `${name}, ${trimmed}`;
          break;
        }
      }
    }
  }

  return {
    title: title || 'Point',
    subtitle,
    name,
  };
}

export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const key = coordKey(lat, lon);
  const cached = reverseCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  if (!isOnlineMode()) {
    return null;
  }

  const url = `https://photon.komoot.io/reverse?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    if (!data.features || data.features.length === 0) {
      reverseCache.set(key, '');
      return null;
    }
    const feat = data.features[0];
    const { name } = formatPlaceProperties(feat.properties || {});
    reverseCache.set(key, name);
    return name;
  } catch {
    return null;
  }
}

export function cachePlaceName(lat: number, lon: number, name: string): void {
  reverseCache.set(coordKey(lat, lon), name);
}

export async function searchPlaces(
  query: string,
  center?: { lat: number; lon: number },
  limit = 5,
): Promise<GeocodePlace[]> {
  const q = query.trim();
  if (!q || !isOnlineMode()) {
    return [];
  }

  if (searchAbortController) {
    searchAbortController.abort();
  }
  searchAbortController = new AbortController();

  let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${limit}`;
  if (center) {
    url += `&lat=${center.lat.toFixed(6)}&lon=${center.lon.toFixed(6)}`;
  }

  try {
    const res = await fetch(url, { signal: searchAbortController.signal });
    if (!res.ok) {
      return [];
    }
    const data = await res.json();
    if (!data.features) {
      return [];
    }

    return data.features.map((feat: any) => {
      const [lon, lat] = feat.geometry.coordinates;
      const { title, subtitle, name } = formatPlaceProperties(feat.properties || {});
      return {
        lat,
        lon,
        title,
        subtitle,
        name,
      };
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return [];
    }
    return [];
  }
}
