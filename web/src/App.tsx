import React, { useState, useEffect, useRef, useCallback } from 'react';
import type maplibregl from 'maplibre-gl';
import type { SegmentHighlight } from './utils/classification.ts';
import { PopoverProvider } from './components/TooltipPopover.tsx';
import { MapView } from './components/MapView.tsx';
import { ControlsPanel } from './components/ControlsPanel.tsx';
import { RouteInfoDrawer } from './components/RouteInfoDrawer.tsx';
import { SettingsSection } from './components/SettingsSection.tsx';
import { AboutModal } from './components/AboutModal.tsx';
import { useRouting } from './hooks/useRouting.ts';
import { useOffline } from './hooks/useOffline.ts';
import { useSettings } from './hooks/useSettings.ts';
import { useMcpBridge } from './mcp-bridge.ts';

export const App: React.FC = () => {
  const mapInstanceRef = useRef<maplibregl.Map | null>(null);

  const settings = useSettings();

  const offline = useOffline(
    (recompute) => routing.clearWorkerGraph(recompute),
    (msg) => routing.setStatus(msg),
  );

  const routing = useRouting(offline.isOfflineMode);

  // Responsive drawer states
  const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches;
  const [isControlsCollapsed, setIsControlsCollapsed] = useState<boolean>(false);
  const [isRouteInfoCollapsed, setIsRouteInfoCollapsed] = useState<boolean>(isMobile);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isAboutOpen, setIsAboutOpen] = useState<boolean>(false);
  const [hoverPosition, setHoverPosition] = useState<{ lat: number; lon: number } | null>(null);
  const [segmentHighlight, setSegmentHighlight] = useState<SegmentHighlight | null>(null);
  const [editingWaypointIndex, setEditingWaypointIndex] = useState<number | null>(null);

  // Auto-collapse controls panel on mobile when route is first computed
  const hadRouteRef = useRef<boolean>(false);
  useEffect(() => {
    setHoverPosition(null);
    setSegmentHighlight(null);
    const hasRoute = !!routing.currentRoute;
    if (hasRoute && !hadRouteRef.current && window.innerWidth <= 860) {
      setIsControlsCollapsed(true);
    }
    hadRouteRef.current = hasRoute;
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

  const handleRequestInlineRename = useCallback((index: number) => {
    setIsControlsCollapsed(false);
    setEditingWaypointIndex(index);
  }, []);

  const handleClearEditingWaypoint = useCallback(() => {
    setEditingWaypointIndex(null);
  }, []);

  const handleMapInstance = useCallback((map: maplibregl.Map) => {
    mapInstanceRef.current = map;
  }, []);

  useMcpBridge({
    mapRef: mapInstanceRef,
    routing,
    offline,
    settings,
    ui: {
      isControlsCollapsed,
      setIsControlsCollapsed,
      isRouteInfoCollapsed,
      setIsRouteInfoCollapsed,
      isSettingsOpen,
      setIsSettingsOpen,
      isAboutOpen,
      setIsAboutOpen,
      hoverPosition,
      setHoverPosition,
      segmentHighlight,
      setSegmentHighlight,
    },
  });

  return (
    <PopoverProvider>
      <ControlsPanel
        routing={routing}
        offline={offline}
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
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenAbout={() => setIsAboutOpen(true)}
        getMapCenter={getMapCenter}
        onFlyTo={handleFlyTo}
        editingWaypointIndex={editingWaypointIndex}
        onClearEditingWaypoint={handleClearEditingWaypoint}
      />

      <RouteInfoDrawer
        slots={routing.slots}
        units={settings.units}
        onSelectSlotAlternative={routing.selectSlotAlternative}
        onRemoveSlot={routing.removeProfileSlot}
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
        hoverPosition={hoverPosition}
        onHoverPosition={setHoverPosition}
        onHighlightSegment={setSegmentHighlight}
      />

      <MapView
        waypoints={routing.waypoints}
        avoidAreas={routing.avoidAreas}
        slots={routing.slots}
        segmentHighlight={segmentHighlight}
        hoverPosition={hoverPosition}
        isOfflineMode={offline.isOfflineMode}
        basemap={settings.basemap}
        thunderforestKey={settings.thunderforestKey}
        fitBoundsSeq={routing.fitBoundsSeq}
        onAddWaypoint={routing.addWaypoint}
        onInsertWaypointAtLeg={routing.insertWaypointAtLeg}
        onMoveWaypoint={routing.moveWaypoint}
        onRemoveWaypoint={routing.removeWaypoint}
        onRenameWaypoint={routing.renameWaypoint}
        onRequestInlineRename={handleRequestInlineRename}
        onAddAvoidArea={routing.addAvoidArea}
        onRemoveAvoidArea={routing.removeAvoidArea}
        onUpdateAvoidAreaRadius={routing.updateAvoidAreaRadius}
        onHoverPosition={setHoverPosition}
        onStatusChange={routing.setStatus}
        onMapInstance={handleMapInstance}
      />

      <SettingsSection
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        units={settings.units}
        onChangeUnits={settings.changeUnits}
        theme={settings.theme}
        onChangeTheme={settings.changeTheme}
        thunderforestKey={settings.thunderforestKey}
        onChangeThunderforestKey={settings.changeThunderforestKey}
        isOfflineMode={offline.isOfflineMode}
        onToggleOfflineMode={offline.setOfflineMode}
        bundleStatus={offline.bundleStatus}
        snapshotDate={offline.snapshotDate}
        downloadProgress={offline.downloadProgress}
        onDownloadOffline={offline.downloadBundle}
        onUpdateOffline={offline.updateBundle}
        onDeleteOffline={offline.deleteBundle}
        onRefreshOfflineStatus={offline.refreshStatus}
      />

      <AboutModal isOpen={isAboutOpen} onClose={() => setIsAboutOpen(false)} />
    </PopoverProvider>
  );
};
