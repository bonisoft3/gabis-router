import React, { useRef } from 'react';
import type { useRouting } from '../hooks/useRouting.ts';
import type { useOffline } from '../hooks/useOffline.ts';
import type { useCompare } from '../hooks/useCompare.ts';
import type { useSettings } from '../hooks/useSettings.ts';
import type { ProfileName } from '../types.ts';
import { routeToGpx, downloadGpxFile } from '../utils/gpx.ts';
import { Header } from './Header.tsx';
import { PlaceSearch } from './PlaceSearch.tsx';
import { WaypointList } from './WaypointList.tsx';
import { CompareCard } from './CompareCard.tsx';
import { SettingsSection } from './SettingsSection.tsx';
import { InfoButton } from './TooltipPopover.tsx';
import { Icon } from './common/Icon.tsx';

interface ControlsPanelProps {
  routing: ReturnType<typeof useRouting>;
  offline: ReturnType<typeof useOffline>;
  compare: ReturnType<typeof useCompare>;
  settings: ReturnType<typeof useSettings>;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onOpenAbout: () => void;
  getMapCenter?: () => { lat: number; lon: number };
  onFlyTo?: (lon: number, lat: number) => void;
}

export const ControlsPanel: React.FC<ControlsPanelProps> = ({
  routing,
  offline,
  compare,
  settings,
  isCollapsed,
  onToggleCollapse,
  onOpenAbout,
  getMapCenter,
  onFlyTo,
}) => {
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const routeSectionRef = useRef<HTMLDivElement | null>(null);

  const keepWaypointsInView = () => {
    if (routeSectionRef.current) routeSectionRef.current.scrollTop = 0;
    if (controlsRef.current) controlsRef.current.scrollTop = 0;
  };

  const handleStartFromMyLocation = () => {
    if (!('geolocation' in navigator)) {
      routing.setStatus('This browser cannot find your location.');
      return;
    }
    routing.setStatus('Finding your location...');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        const next =
          routing.waypoints.length === 0
            ? [here]
            : [here, ...routing.waypoints.slice(1)];
        routing.setWaypoints(next);
        if (routing.waypoints.length < 2) {
          onFlyTo?.(here.lon, here.lat);
        }
      },
      (err) => {
        const GEOLOCATION_ERRORS: Record<number, string> = {
          1: 'Location permission was denied. Allow it in the browser settings and try again.',
          2: 'Your location is not available right now.',
          3: 'Finding your location took too long. Try again.',
        };
        routing.setStatus(
          GEOLOCATION_ERRORS[err.code] ?? `Could not find your location: ${err.message}`,
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
  };

  const handleShare = async () => {
    const url = location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'rsrouter route', url });
      } else {
        await navigator.clipboard.writeText(url);
        routing.setStatus('Link copied. Anyone who opens it sees this route.');
      }
    } catch (err: any) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      routing.setStatus(`Could not share: ${err.message || String(err)}`);
    }
  };

  const handleExportGpx = () => {
    if (!routing.currentRoute) return;
    const startName = routing.waypoints[0]?.name;
    const endName = routing.waypoints[routing.waypoints.length - 1]?.name;
    const trackName =
      startName && endName ? `${startName} to ${endName}` : `${routing.profile}_route`;
    const filename = `${trackName.replace(/[/\\?%*:|"<>]/g, '_')}.gpx`;
    downloadGpxFile(routeToGpx(routing.currentRoute, trackName), filename);
    routing.setStatus(`Route exported as ${filename}`);
  };

  return (
    <div id="controls" ref={controlsRef} className={isCollapsed ? 'collapsed' : ''}>
      <Header
        profile={routing.profile}
        isCollapsed={isCollapsed}
        onToggleCollapse={onToggleCollapse}
        onOpenAbout={onOpenAbout}
      />

      <div className="route-section" ref={routeSectionRef}>
        <div className="field">
          <label htmlFor="profile-select">
            Routing Profile{' '}
            <InfoButton
              tooltip="Profiles change road weights to fit different riding styles. For example, safe road profiles avoid fast traffic, while gravel profiles allow unpaved tracks."
              ariaLabel="About Routing Profiles"
            />
          </label>
          <select
            id="profile-select"
            value={routing.profile}
            onChange={(e) => routing.setProfile(e.target.value as ProfileName)}
          >
            <option value="fastbike">Fastbike</option>
            <option value="fastbike-lowtraffic">Fastbike Low Traffic</option>
            <option value="fastbike-verylowtraffic">Fastbike Very Low Traffic</option>
            <option value="gabis-lite-gravel">Gabi's Lite Gravel</option>
            <option value="gabis-safe-road">Gabi's Safe Road</option>
            <option value="gravel">Gravel</option>
            <option value="trekking">Trekking</option>
          </select>
        </div>

        <PlaceSearch
          isOfflineMode={offline.isOfflineMode}
          getMapCenter={getMapCenter}
          onFlyTo={onFlyTo}
          onSelectPlace={(point, action) => {
            if (action === 'start') {
              routing.setWaypoints(
                routing.waypoints.length === 0 ? [point] : [point, ...routing.waypoints.slice(1)],
              );
            } else if (action === 'end') {
              routing.setWaypoints(
                routing.waypoints.length < 2
                  ? [...routing.waypoints, point]
                  : [...routing.waypoints.slice(0, -1), point],
              );
            } else {
              routing.setWaypoints([...routing.waypoints, point]);
            }
          }}
        />

        <button
          id="btn-my-location"
          type="button"
          className="btn btn-outline"
          style={{ width: '100%', marginBottom: '10px' }}
          onClick={handleStartFromMyLocation}
        >
          Start from my location
        </button>

        <WaypointList
          waypoints={routing.waypoints}
          onReorder={routing.reorderWaypoints}
          onRemove={routing.removeWaypoint}
          onRename={routing.renameWaypoint}
        />

        <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center' }}>
          <button
            id="btn-undo"
            type="button"
            className="btn btn-outline btn-icon"
            title="Undo (Cmd+Z / Ctrl+Z)"
            aria-label="Undo"
            disabled={!routing.canUndo}
            onClick={routing.undo}
          >
            <Icon name="undo" size={15} />
          </button>
          <button
            id="btn-clear-route"
            type="button"
            className="btn btn-outline"
            style={{ flex: 1 }}
            onClick={routing.clearRoute}
          >
            Clear Route
          </button>
          <button
            id="btn-redo"
            type="button"
            className="btn btn-outline btn-icon"
            title="Redo (Cmd+Shift+Z / Ctrl+Y)"
            aria-label="Redo"
            disabled={!routing.canRedo}
            onClick={routing.redo}
          >
            <Icon name="redo" size={15} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
          <button
            id="btn-share"
            type="button"
            className="btn btn-outline"
            style={{ flex: 1 }}
            disabled={routing.waypoints.length < 2}
            onClick={handleShare}
          >
            Share link
          </button>
          <button
            id="btn-export-gpx"
            type="button"
            className="btn btn-primary"
            style={{ flex: 1 }}
            disabled={!routing.currentRoute}
            onClick={handleExportGpx}
          >
            Export GPX
          </button>
        </div>

        <CompareCard
          comparedRoute={compare.comparedRoute}
          currentRoute={routing.currentRoute}
          units={settings.units}
          onLoadGpxFile={compare.loadGpxFile}
          onClearCompare={compare.clearComparedRoute}
          onMatchCompare={compare.matchStartAndEnd}
        />

        <div id="status">{routing.status}</div>

        <SettingsSection
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
          onOpenAbout={onOpenAbout}
          onKeepInView={keepWaypointsInView}
        />
      </div>
    </div>
  );
};
