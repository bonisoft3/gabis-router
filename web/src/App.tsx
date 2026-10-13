import React, { useState, useEffect, useRef, useCallback } from 'react';
import type maplibregl from 'maplibre-gl';
import type { SegmentHighlight } from './utils/classification.ts';
import { PopoverProvider } from './components/TooltipPopover.tsx';
import { MapView } from './components/MapView.tsx';
import { ControlsPanel } from './components/ControlsPanel.tsx';
import { RouteInfoDrawer } from './components/RouteInfoDrawer.tsx';
import { AboutModal } from './components/AboutModal.tsx';
import { useRouting } from './hooks/useRouting.ts';
import { useOffline } from './hooks/useOffline.ts';
import { useCompare } from './hooks/useCompare.ts';
import { useSettings } from './hooks/useSettings.ts';

export const App: React.FC = () => {
  const mapInstanceRef = useRef<maplibregl.Map | null>(null);

  const settings = useSettings();

  const offline = useOffline(
    () => routing.clearWorkerGraph(),
    (msg) => routing.setStatus(msg),
  );

  const routing = useRouting(offline.isOfflineMode);

  const compare = useCompare(
    (wps) => routing.setWaypoints(wps, true),
    (msg) => routing.setStatus(msg),
  );

  // Responsive drawer states
  const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches;
  const [isControlsCollapsed, setIsControlsCollapsed] = useState<boolean>(false);
  const [isRouteInfoCollapsed, setIsRouteInfoCollapsed] = useState<boolean>(isMobile);
  const [isAboutOpen, setIsAboutOpen] = useState<boolean>(false);
  const [hoverPosition, setHoverPosition] = useState<{ lat: number; lon: number } | null>(null);
  const [segmentHighlight, setSegmentHighlight] = useState<SegmentHighlight | null>(null);

  // Auto-collapse controls panel on mobile when route is computed
  useEffect(() => {
    if (routing.currentRoute && window.innerWidth <= 860) {
      setIsControlsCollapsed(true);
    }
  }, [routing.currentRoute]);

  // Global undo/redo keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.matches('input, select, textarea')) return;

      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        routing.undo();
      } else if (
        ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'z') ||
        ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'y')
      ) {
        e.preventDefault();
        routing.redo();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [routing]);

  const handleFlyTo = useCallback((lon: number, lat: number) => {
    const map = mapInstanceRef.current;
    if (map) {
      map.flyTo({
        center: [lon, lat],
        zoom: Math.max(map.getZoom(), 14),
      });
    }
  }, []);

  const getMapCenter = useCallback(() => {
    const map = mapInstanceRef.current;
    if (map) {
      const c = map.getCenter();
      return { lat: c.lat, lon: c.lng };
    }
    return { lat: 54.5, lon: -4.5 };
  }, []);

  return (
    <PopoverProvider>
      <MapView
        waypoints={routing.waypoints}
        avoidAreas={routing.avoidAreas}
        currentRoute={routing.currentRoute}
        comparedRoute={compare.comparedRoute}
        segmentHighlight={segmentHighlight}
        hoverPosition={hoverPosition}
        isOfflineMode={offline.isOfflineMode}
        basemap={settings.basemap}
        thunderforestKey={settings.thunderforestKey}
        onAddWaypoint={routing.addWaypoint}
        onMoveWaypoint={routing.moveWaypoint}
        onRemoveWaypoint={routing.removeWaypoint}
        onRenameWaypoint={routing.renameWaypoint}
        onAddAvoidArea={routing.addAvoidArea}
        onRemoveAvoidArea={routing.removeAvoidArea}
        onStatusChange={(msg) => routing.setStatus(msg)}
        onMapInstance={(map) => {
          mapInstanceRef.current = map;
        }}
      />

      <ControlsPanel
        routing={routing}
        offline={offline}
        compare={compare}
        settings={settings}
        isCollapsed={isControlsCollapsed}
        onToggleCollapse={() => {
          setIsControlsCollapsed((prev) => {
            const next = !prev;
            if (!next && window.innerWidth <= 860) {
              setIsRouteInfoCollapsed(true);
            }
            return next;
          });
        }}
        onOpenAbout={() => setIsAboutOpen(true)}
        getMapCenter={getMapCenter}
        onFlyTo={handleFlyTo}
      />

      <RouteInfoDrawer
        currentRoute={routing.currentRoute}
        comparedRoute={compare.comparedRoute}
        units={settings.units}
        isCollapsed={isRouteInfoCollapsed}
        onToggleCollapse={() => {
          setIsRouteInfoCollapsed((prev) => {
            const next = !prev;
            if (!next && window.innerWidth <= 860) {
              setIsControlsCollapsed(true);
            }
            return next;
          });
        }}
        onHoverPosition={(pos) => setHoverPosition(pos)}
        onHighlightSegment={(hl) => setSegmentHighlight(hl)}
      />

      <AboutModal isOpen={isAboutOpen} onClose={() => setIsAboutOpen(false)} />
    </PopoverProvider>
  );
};
