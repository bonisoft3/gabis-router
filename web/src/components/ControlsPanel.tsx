import React, { useRef, useState } from 'react';
import type { useRouting } from '../hooks/useRouting.ts';
import type { useOffline } from '../hooks/useOffline.ts';
import {
  MAX_ROUTE_SLOTS,
  PROFILE_INFO,
  PROFILE_ORDER,
  ROUTE_SLOT_COLORS,
  type ProfileName,
} from '../types.ts';
import { routeToGpx, downloadGpxFile } from '../utils/gpx.ts';
import { getShareableRouteUrl, isNativePlatform } from '../platform.ts';
import { Header } from './Header.tsx';
import { PlaceSearch } from './PlaceSearch.tsx';
import { WaypointList } from './WaypointList.tsx';
import { InfoButton } from './TooltipPopover.tsx';
import { Icon } from './common/Icon.tsx';

interface ControlsPanelProps {
  routing: ReturnType<typeof useRouting>;
  offline: ReturnType<typeof useOffline>;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  getMapCenter?: () => { lat: number; lon: number };
  onFlyTo?: (lon: number, lat: number) => void;
  editingWaypointIndex?: number | null;
  onClearEditingWaypoint?: () => void;
}

export const ControlsPanel: React.FC<ControlsPanelProps> = ({
  routing,
  offline,
  isCollapsed,
  onToggleCollapse,
  onOpenSettings,
  onOpenAbout,
  getMapCenter,
  onFlyTo,
  editingWaypointIndex,
  onClearEditingWaypoint,
}) => {
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const routeSectionRef = useRef<HTMLDivElement | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const [shareCopied, setShareCopied] = useState(false);

  const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      routing.importGpxFile(file);
    }
    e.target.value = '';
  };

  const handleStartFromMyLocation = () => {
    if (!('geolocation' in navigator)) {
      routing.setStatus('This browser cannot find your location.', true);
      return;
    }
    routing.setStatus('Finding your location...');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        const shouldFly = routing.waypoints.length < 2;
        routing.addWaypoint(here, 'start');
        if (shouldFly) {
          onFlyTo?.(here.lon, here.lat);
        }
      },
      (err) => {
        const GEOLOCATION_ERRORS: Record<number, string> = {
          1: 'Location permission was denied. Allow it in browser settings and try again.',
          2: 'Your location is not available right now.',
          3: 'Finding your location took too long. Try again.',
        };
        routing.setStatus(
          GEOLOCATION_ERRORS[err.code] ?? `Could not find your location: ${err.message}`,
          true,
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
  };

  const handleShare = async () => {
    const url = getShareableRouteUrl();
    try {
      if (typeof window !== 'undefined' && window.AndroidNative?.shareText) {
        if (window.AndroidNative.shareText('GBRouter route', url)) {
          return;
        }
      }
      if (navigator.share && (isNativePlatform() || window.matchMedia('(pointer: coarse)').matches)) {
        await navigator.share({ title: 'GBRouter route', url });
      } else {
        await navigator.clipboard.writeText(url);
        setShareCopied(true);
        routing.setStatus('Link copied. Anyone who opens it sees this route.');
        setTimeout(() => setShareCopied(false), 2000);
      }
    } catch (err: any) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      routing.setStatus(`Could not share: ${err.message || String(err)}`, true);
    }
  };

  const handleExportGpx = async () => {
    if (!routing.currentRoute) return;
    const startName = routing.waypoints[0]?.name;
    const endName = routing.waypoints[routing.waypoints.length - 1]?.name;
    const trackName =
      startName && endName ? `${startName} to ${endName}` : `${routing.profile}_route`;
    const filename = `${trackName.replace(/[/\\?%*:|"<>]/g, '_')}.gpx`;
    await downloadGpxFile(routeToGpx(routing.currentRoute, trackName), filename);
    routing.setStatus(`Route exported as ${filename}`);
  };

  const isBusy = routing.isRouting || offline.downloadProgress.active;

  return (
    <div id="controls" ref={controlsRef} className={isCollapsed ? 'collapsed' : ''}>
      <Header
        profile={routing.profile}
        compareCount={Math.max(0, routing.slots.length - 1)}
        isOfflineMode={offline.isOfflineMode}
        isCollapsed={isCollapsed}
        onToggleCollapse={onToggleCollapse}
        onOpenSettings={onOpenSettings}
        onOpenAbout={onOpenAbout}
      />

      <div className="route-section" ref={routeSectionRef}>
        <div className="field profile-field">
          <div className="profile-field-header">
            <label htmlFor="profile-select">
              <span>{routing.slots.length > 1 ? 'Profiles' : 'Profile'}</span>
              <InfoButton
                tooltip={`${PROFILE_INFO[routing.profile]?.summary || ''} Profiles score every road segment by surface, traffic, hills, and cycle infrastructure. Add up to 3 profiles to compare routes side by side.`}
                ariaLabel="About Routing Profiles"
              />
            </label>
            {routing.slots.length < MAX_ROUTE_SLOTS && (
              <button
                id="btn-add-compare-profile"
                type="button"
                className="btn-toolbar-mini btn-add-profile"
                title="Add another routing profile to compare (up to 3)"
                onClick={() => routing.addProfileSlot()}
              >
                <span>+ Compare profile</span>
              </button>
            )}
          </div>

          <div className="profile-slots-list">
            {routing.slots.map((slot, slotIdx) => {
              const slotColor = ROUTE_SLOT_COLORS[slotIdx] || ROUTE_SLOT_COLORS[0];
              return (
                <div key={slotIdx} className="profile-slot-row">
                  <span
                    className="profile-slot-dot"
                    style={{ backgroundColor: slotColor.line }}
                    title={`Route ${slotIdx + 1} (${slotColor.name})`}
                  />
                  <select
                    id={slotIdx === 0 ? 'profile-select' : `profile-select-${slotIdx}`}
                    value={slot.profile}
                    title={PROFILE_INFO[slot.profile]?.summary}
                    onChange={(e) => routing.setSlotProfile(slotIdx, e.target.value as ProfileName)}
                  >
                    {PROFILE_ORDER.map((key) => (
                      <option key={key} value={key}>
                        {PROFILE_INFO[key].label}
                      </option>
                    ))}
                  </select>
                  {routing.slots.length > 1 && (
                    <button
                      id={`btn-remove-profile-${slotIdx}`}
                      type="button"
                      className="wp-btn wp-btn-remove profile-slot-remove"
                      title="Remove this profile from comparison"
                      aria-label={`Remove profile ${slotIdx + 1}`}
                      onClick={() => routing.removeProfileSlot(slotIdx)}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <PlaceSearch
          isOfflineMode={offline.isOfflineMode}
          getMapCenter={getMapCenter}
          onFlyTo={onFlyTo}
          onStartFromMyLocation={handleStartFromMyLocation}
          onSelectPlace={(point, action) => {
            routing.addWaypoint(point, action);
          }}
        />

        <div className="waypoints-header">
          <span className="waypoints-title">Waypoints</span>
          <div className="route-toolbar-group">
            <input
              ref={importFileInputRef}
              type="file"
              id="input-import-gpx"
              accept=".gpx"
              style={{ display: 'none' }}
              onChange={handleImportFileChange}
            />
            <button
              id="btn-import-gpx"
              type="button"
              className="btn-toolbar-mini"
              title="Import GPX as editable route"
              aria-label="Import GPX"
              onClick={() => importFileInputRef.current?.click()}
            >
              <Icon name="upload" size={12} />
              <span>Import GPX</span>
            </button>
            <button
              id="btn-undo"
              type="button"
              className="btn-toolbar-mini"
              title="Undo (Cmd+Z / Ctrl+Z)"
              aria-label="Undo"
              disabled={!routing.canUndo}
              onClick={routing.undo}
            >
              <Icon name="undo" size={13} />
            </button>
            <button
              id="btn-redo"
              type="button"
              className="btn-toolbar-mini"
              title="Redo (Cmd+Shift+Z / Ctrl+Y)"
              aria-label="Redo"
              disabled={!routing.canRedo}
              onClick={routing.redo}
            >
              <Icon name="redo" size={13} />
            </button>
            <button
              id="btn-reverse-route"
              type="button"
              className="btn-toolbar-mini"
              title="Reverse route direction"
              aria-label="Reverse route"
              disabled={routing.waypoints.length < 2}
              onClick={routing.reverseRoute}
            >
              <Icon name="reverse" size={13} />
            </button>
            <button
              id="btn-clear-route"
              type="button"
              className="btn-toolbar-mini btn-toolbar-clear"
              title="Clear route and avoid areas"
              aria-label="Clear route"
              disabled={routing.waypoints.length === 0 && routing.avoidAreas.length === 0}
              onClick={routing.clearRoute}
            >
              <Icon name="trash" size={12} />
              <span>Clear</span>
            </button>
          </div>
        </div>

        <WaypointList
          waypoints={routing.waypoints}
          avoidAreas={routing.avoidAreas}
          editingWaypointIndex={editingWaypointIndex}
          onClearEditingWaypoint={onClearEditingWaypoint}
          onReorder={routing.reorderWaypoints}
          onRemove={routing.removeWaypoint}
          onRename={routing.renameWaypoint}
          onRemoveAvoidArea={routing.removeAvoidArea}
          onUpdateAvoidAreaRadius={routing.updateAvoidAreaRadius}
          onClearAvoidAreas={routing.clearAvoidAreas}
          onFlyTo={onFlyTo}
        />

        <div className="route-section-footer">
          <div
            id="status"
            className={`status-bar ${isBusy ? 'is-busy' : ''} ${routing.isError ? 'is-error' : ''}`}
            role="status"
            aria-live="polite"
          >
            {isBusy && <span className="status-spinner" aria-hidden="true" />}
            {routing.status && <span className="status-text">{routing.status}</span>}
          </div>

          <div className="route-primary-actions">
            <button
              id="btn-share"
              type="button"
              className="btn btn-outline btn-action-compact"
              title="Copy shareable route link"
              disabled={routing.waypoints.length < 2}
              onClick={handleShare}
            >
              <Icon name={shareCopied ? 'check' : 'share'} size={13} />
              <span>{shareCopied ? 'Copied' : 'Share'}</span>
            </button>

            <button
              id="btn-export-gpx"
              type="button"
              className="btn btn-primary btn-action-compact"
              title="Download primary route as GPX file"
              disabled={!routing.currentRoute}
              onClick={handleExportGpx}
            >
              <Icon name="download" size={13} />
              <span>Export GPX</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
