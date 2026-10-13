import React, { useRef } from 'react';
import type { Units } from '../format.ts';
import type { Theme } from '../theme.ts';
import type { OfflineBundleStatus, DownloadProgress } from '../hooks/useOffline.ts';
import { InfoButton } from './TooltipPopover.tsx';

interface SettingsSectionProps {
  units: Units;
  onChangeUnits: (units: Units) => void;
  theme: Theme;
  onChangeTheme: (theme: Theme) => void;
  thunderforestKey: string;
  onChangeThunderforestKey: (key: string) => void;
  isOfflineMode: boolean;
  onToggleOfflineMode: (enabled: boolean) => void;
  bundleStatus: OfflineBundleStatus;
  snapshotDate: Date | null;
  downloadProgress: DownloadProgress;
  onDownloadOffline: () => void;
  onUpdateOffline: () => void;
  onDeleteOffline: () => void;
  onOpenAbout: () => void;
  onKeepInView?: () => void;
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  units,
  onChangeUnits,
  theme,
  onChangeTheme,
  thunderforestKey,
  onChangeThunderforestKey,
  isOfflineMode,
  onToggleOfflineMode,
  bundleStatus,
  snapshotDate,
  downloadProgress,
  onDownloadOffline,
  onUpdateOffline,
  onDeleteOffline,
  onOpenAbout,
  onKeepInView,
}) => {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  const handleToggle = () => {
    onKeepInView?.();
  };

  const handleOfflineModeCheckbox = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!bundleStatus.ready && e.target.checked) {
      alert('Download UK offline data before enabling offline mode.');
      return;
    }
    onToggleOfflineMode(e.target.checked);
  };

  const mb = Math.round(bundleStatus.totalBytes / (1024 * 1024));

  return (
    <details className="settings" ref={detailsRef} onToggle={handleToggle}>
      <summary onClick={handleToggle}>Settings</summary>
      <div className="field">
        <label htmlFor="select-units">Units</label>
        <select
          id="select-units"
          value={units}
          onChange={(e) => onChangeUnits(e.target.value as Units)}
        >
          <option value="metric">Kilometres and metres</option>
          <option value="imperial">Miles and feet</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor="select-theme">Appearance</label>
        <select
          id="select-theme"
          value={theme}
          onChange={(e) => onChangeTheme(e.target.value as Theme)}
        >
          <option value="auto">Match my device</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>

      <div className="field offline-section" style={{ marginTop: '10px', marginBottom: '10px' }}>
        <label>Offline Routing &amp; Data</label>
        <div className="offline-mode-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <label className="offline-mode-toggle" htmlFor="check-offline-mode">
              <input
                type="checkbox"
                id="check-offline-mode"
                checked={isOfflineMode}
                disabled={!bundleStatus.ready}
                onChange={handleOfflineModeCheckbox}
              />
              <span className="offline-slider"></span>
              <span className="offline-mode-title">Offline Mode</span>
            </label>
            <InfoButton
              tooltip="Routes are computed entirely inside your browser. Once map tiles and routing data are downloaded, no internet connection is required."
              ariaLabel="About Offline Mode"
            />
          </div>
          <span
            id="badge-offline-status"
            className={`offline-badge ${isOfflineMode ? 'badge-offline' : 'badge-online'}`}
          >
            {isOfflineMode ? 'Offline' : 'Online'}
          </span>
        </div>

        <div id="offline-download-card" className="offline-card">
          <div className="offline-card-header">
            <span className="offline-card-title">UK Offline Data</span>
            <span
              id="offline-card-badge"
              className={`offline-mini-badge ${bundleStatus.ready ? 'badge-ready' : 'badge-missing'}`}
            >
              {bundleStatus.ready ? 'Ready' : 'Not Downloaded'}
            </span>
          </div>
          <p id="offline-card-desc" className="offline-card-desc">
            {bundleStatus.ready
              ? `UK and Ireland offline data ready: ${mb} MB.`
              : 'Download UK routing data and map tiles to enable offline mode.'}
          </p>
          <div
            id="offline-data-date-row"
            style={{
              fontSize: '0.75rem',
              color: 'var(--muted)',
              marginTop: '6px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>Snapshot date:</span>
            <span id="offline-data-date" style={{ fontWeight: 500, color: 'var(--text-2)' }}>
              {snapshotDate
                ? snapshotDate.toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })
                : 'Not cached'}
            </span>
          </div>

          {downloadProgress.active && (
            <div id="offline-progress-bar-container" className="progress-container">
              <div
                id="offline-progress-bar"
                className="progress-bar"
                style={{ width: `${downloadProgress.percent}%` }}
              ></div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            {!bundleStatus.ready && (
              <button
                id="btn-download-offline"
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={downloadProgress.active}
                onClick={onDownloadOffline}
              >
                {downloadProgress.active
                  ? 'Downloading...'
                  : bundleStatus.hasAny
                  ? 'Resume Download'
                  : 'Download UK Data'}
              </button>
            )}

            {bundleStatus.ready && (
              <button
                id="btn-update-offline"
                className="btn btn-secondary"
                style={{ flex: 1 }}
                disabled={downloadProgress.active}
                onClick={onUpdateOffline}
              >
                {downloadProgress.active ? 'Updating...' : 'Update'}
              </button>
            )}

            {(bundleStatus.ready || bundleStatus.hasAny) && (
              <button
                id="btn-delete-offline"
                className="btn btn-danger"
                disabled={downloadProgress.active}
                onClick={onDeleteOffline}
              >
                Delete
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="field">
        <label htmlFor="input-thunderforest-key">Thunderforest API Key (optional)</label>
        <input
          type="text"
          id="input-thunderforest-key"
          placeholder="Default key active"
          autoComplete="off"
          spellCheck="false"
          value={thunderforestKey}
          onChange={(e) => onChangeThunderforestKey(e.target.value)}
        />
        <small style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: '4px', display: 'block' }}>
          Default key active. Supply your own key from{' '}
          <a
            href="https://www.thunderforest.com/"
            target="_blank"
            rel="noopener"
            style={{ color: '#2563eb' }}
          >
            thunderforest.com
          </a>
          .
        </small>
      </div>

      <button
        id="btn-about-settings"
        type="button"
        className="btn btn-outline"
        style={{ width: '100%', marginTop: '12px' }}
        onClick={onOpenAbout}
      >
        About GBRouter
      </button>
    </details>
  );
};
