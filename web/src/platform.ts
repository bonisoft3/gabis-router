/**
 * Platform detection and environment-aware helpers for Web (PWA) and Android (Capacitor).
 */

declare global {
  interface Window {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      getPlatform?: () => string;
    };
    AndroidNative?: {
      exportGpx?: (gpxContent: string, filename: string) => boolean;
      shareText?: (title: string, text: string) => boolean;
    };
  }
}

const env = (import.meta as any).env || {};

/**
 * Returns true when running inside a native Capacitor WebView shell (Android/iOS).
 */
export function isNativePlatform(): boolean {
  if (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform) {
    return Boolean(window.Capacitor.isNativePlatform());
  }
  return false;
}

/**
 * Resolves the network URL used to download a 5°×5° `.rd5` routing segment.
 * Note: CacheStorage always keys segments under `/segments4/<id>.rd5` regardless of download URL.
 */
export function getSegmentDownloadUrl(segmentId: string): string {
  const base = env.VITE_SEGMENTS_BASE_URL ? String(env.VITE_SEGMENTS_BASE_URL).replace(/\/+$/, '') : '/segments4';
  return `${base}/${segmentId}.rd5`;
}

/**
 * Resolves the network URL used to download a 5°×5° `.pmtiles` offline map archive.
 */
export function getMapTileDownloadUrl(segmentId: string): string {
  const base = env.VITE_MAP_TILES_BASE_URL ? String(env.VITE_MAP_TILES_BASE_URL).replace(/\/+$/, '') : '/map-tiles';
  return `${base}/${segmentId}.pmtiles`;
}

/**
 * Returns a shareable URL for the current route.
 * Inside a native Capacitor shell (`https://localhost`), rewrites the origin to `VITE_PUBLIC_WEB_URL`
 * so shared links open on the web rather than pointing to `localhost`.
 */
export function getShareableRouteUrl(): string {
  if (typeof window === 'undefined') return '';
  if (isNativePlatform() || window.location.hostname === 'localhost') {
    const publicBase = env.VITE_PUBLIC_WEB_URL
      ? String(env.VITE_PUBLIC_WEB_URL).replace(/\/+$/, '')
      : window.location.origin;
    return `${publicBase}${window.location.pathname}${window.location.search}${window.location.hash}`;
  }
  return window.location.href;
}
