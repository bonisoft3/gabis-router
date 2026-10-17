import { useState, useEffect, useCallback } from 'react';
import { parseGpx, type ComparedRoute } from '../utils/gpx.ts';
import type { LatLon } from '../types.ts';

export function useCompare(
  onMatchWaypoints: (wps: LatLon[]) => void,
  onStatusChange: (status: string, isError?: boolean) => void,
  onGpxLoaded?: (route: ComparedRoute) => void,
) {
  const [comparedRoute, setComparedRoute] = useState<ComparedRoute | null>(null);

  const loadGpxContent = useCallback(
    (xmlText: string) => {
      try {
        const route = parseGpx(xmlText);
        setComparedRoute(route);
        onStatusChange(`Loaded GPX: ${route.name}`);
        onGpxLoaded?.(route);
      } catch (err: any) {
        onStatusChange(`Could not load GPX: ${err.message || String(err)}`, true);
      }
    },
    [onStatusChange, onGpxLoaded],
  );

  const loadGpxFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        if (text) loadGpxContent(text);
      };
      reader.readAsText(file);
    },
    [loadGpxContent],
  );

  const clearComparedRoute = useCallback(() => {
    setComparedRoute(null);
  }, []);

  const matchStartAndEnd = useCallback(() => {
    if (!comparedRoute || comparedRoute.coordinates.length < 2) return;
    const first = comparedRoute.coordinates[0];
    const last = comparedRoute.coordinates[comparedRoute.coordinates.length - 1];
    onMatchWaypoints([
      { lon: first[0], lat: first[1] },
      { lon: last[0], lat: last[1] },
    ]);
  }, [comparedRoute, onMatchWaypoints]);

  // Window drag and drop for GPX files only (do not hijack internal element drag-and-drop)
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };

    const handleDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file && file.name.toLowerCase().endsWith('.gpx')) {
        loadGpxFile(file);
      }
    };

    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('drop', handleDrop);
    return () => {
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('drop', handleDrop);
    };
  }, [loadGpxFile]);

  return {
    comparedRoute,
    loadGpxContent,
    loadGpxFile,
    clearComparedRoute,
    matchStartAndEnd,
  };
}

