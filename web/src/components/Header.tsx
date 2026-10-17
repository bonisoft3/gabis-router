import React from 'react';
import { PROFILE_INFO, type ProfileName } from '../types.ts';
import { Icon } from './common/Icon.tsx';

interface HeaderProps {
  profile: ProfileName;
  compareCount?: number;
  isOfflineMode?: boolean;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  profile,
  compareCount = 0,
  isOfflineMode,
  isCollapsed,
  onToggleCollapse,
  onOpenSettings,
  onOpenAbout,
}) => {
  const profileMeta = PROFILE_INFO[profile];
  const badgeLabel = `${profileMeta?.shortLabel || profile}${compareCount > 0 ? ` +${compareCount}` : ''}`;

  return (
    <div
      className="header"
      onClick={() => {
        if (isCollapsed) onToggleCollapse();
      }}
    >
      <div className="header-top">
        <div className="header-title-wrap">
          <h1>
            <span className="header-logo" aria-hidden="true">
              <Icon name="bike" size={16} />
            </span>
            <span>GBRouter</span>
          </h1>
          {isCollapsed && (
            <span id="header-profile-badge" className="header-profile-badge">
              {badgeLabel}
            </span>
          )}
          {isOfflineMode && (
            <span className="header-offline-pill" title="Offline Mode Active">
              Offline
            </span>
          )}
        </div>
        <div className="header-actions">
          <button
            id="btn-settings"
            type="button"
            className="collapse-btn"
            title="Settings & Offline Data"
            aria-label="Settings"
            onClick={(e) => {
              e.stopPropagation();
              onOpenSettings();
            }}
          >
            <Icon name="settings" size={15} />
          </button>
          <button
            id="btn-about"
            type="button"
            className="collapse-btn"
            title="About GBRouter"
            aria-label="About GBRouter"
            onClick={(e) => {
              e.stopPropagation();
              onOpenAbout();
            }}
          >
            <Icon name="info" size={15} />
          </button>
          <button
            id="btn-toggle-collapse"
            type="button"
            className="collapse-btn"
            title={isCollapsed ? 'Expand controls' : 'Collapse controls'}
            aria-label={isCollapsed ? 'Expand panel' : 'Collapse panel'}
            aria-expanded={!isCollapsed}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse();
            }}
          >
            <Icon id="collapse-icon" name="chevron-up" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
};

