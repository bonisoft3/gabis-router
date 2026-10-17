import React, { useEffect } from 'react';
import type { Units } from '../format.ts';
import type { Theme } from '../theme.ts';
import type { OfflineBundleStatus, DownloadProgress } from '../hooks/useOffline.ts';
import { InfoButton } from './TooltipPopover.tsx';
import { Icon } from './common/Icon.tsx';

interface SettingsSectionProps {
  isOpen: boolean;
  onClose: () => void;
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
  onRefreshOfflineStatus?: () => void;
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  isOpen,
  onClose,
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
  onRefreshOfflineStatus,
}) => {
  useEffect(() => {
    if (!isOpen) return;
    onRefreshOfflineStatus?.();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, onRefreshOfflineStatus]);

  if (!isOpen) return null;

  const handleOfflineModeCheckbox = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!bundleStatus.ready && e.target.checked) {
      return;
    }
    onToggleOfflineMode(e.target.checked);
  };

  const mb = Math.round(bundleStatus.totalBytes / (1024 * 1024));

  return (
    <div
      id="settings-modal"
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="about-header">
          <div className="about-header-text">
            <h2 id="settings-title">
              <Icon name="settings" size={18} />
              <span>Settings</span>
            </h2>
            <p>Display preferences, offline routing data, and map keys.</p>
          </div>
          <button
            id="btn-close-settings"
            type="button"
            className="about-close-btn"
            aria-label="Close settings"
            onClick={onClose}
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="about-body settings-body">
          <div className="settings-grid-2">
            <div className="field">
              <label htmlFor="select-units">Units</label>
              <select
                id="select-units"
                value={units}
                onChange={(e) => onChangeUnits(e.target.value as Units)}
              >
                <option value="metric">Metric (km, m)</option>
                <option value="imperial">Imperial (mi, ft)</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="select-theme">Appearance</label>
              <select
                id="select-theme"
                value={theme}
                onChange={(e) => onChangeTheme(e.target.value as Theme)}
              >
                <option value="auto">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
          </div>

          <div className="field offline-section">
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
                  tooltip="Routes are computed inside your browser. Once map tiles and routing data are downloaded, no internet connection is required."
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

              {downloadProgress.active && (
                <div className="offline-progress-wrap">
                  <div className="offline-progress-info">
                    <span className="offline-progress-msg">{downloadProgress.message || 'Downloading...'}</span>
                    <span className="offline-progress-pct">{downloadProgress.percent}%</span>
                  </div>
                  <div id="offline-progress-bar-container" className="progress-container">
                    <div
                      id="offline-progress-bar"
                      className="progress-bar"
                      style={{ width: `${downloadProgress.percent}%` }}
                    ></div>
                  </div>
                </div>
              )}

              <div className="offline-card-actions">
                {!bundleStatus.ready && (
                  <button
                    id="btn-download-offline"
                    type="button"
                    className="btn btn-primary"
                    style={{ flex: 1 }}
                    disabled={downloadProgress.active}
                    onClick={onDownloadOffline}
                  >
                    {downloadProgress.active
                      ? 'Downloading...'
                      : bundleStatus.hasPartialTiles
                      ? 'Resume Download'
                      : 'Download UK Data'}
                  </button>
                )}

                {bundleStatus.hasPartialTiles && (
                  <button
                    id="btn-delete-offline"
                    type="button"
                    className="btn btn-danger"
                    style={bundleStatus.ready ? { flex: 1 } : undefined}
                    disabled={downloadProgress.active}
                    onClick={onDeleteOffline}
                  >
                    Delete
                  </button>
                )}
              </div>

              <div id="offline-data-date-row" className="offline-cache-footer">
                <div className="offline-cache-meta">
                  <span>Routing cache:</span>
                  <span
                    id="offline-data-date"
                    className="offline-meta-val"
                    title={snapshotDate ? snapshotDate.toISOString() : ''}
                  >
                    {snapshotDate
                      ? snapshotDate.toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })
                      : 'Not cached'}
                  </span>
                </div>
                <button
                  id="btn-update-offline"
                  type="button"
                  className="offline-clear-cache-btn"
                  title="Clear cached routing segments so they re-fetch when routing"
                  disabled={downloadProgress.active}
                  onClick={onUpdateOffline}
                >
                  Clear cache
                </button>
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
            <small className="field-hint">
              Default key active for OpenCycleMap. Supply your own key from{' '}
              <a
                href="https://www.thunderforest.com/"
                target="_blank"
                rel="noopener"
              >
                thunderforest.com
              </a>
              .
            </small>
          </div>
        </div>
      </div>
    </div>
  );
};
