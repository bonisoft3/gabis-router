import React from 'react';
import type { ProfileName } from '../types.ts';
import { Icon } from './common/Icon.tsx';

const PROFILE_LABELS: Record<ProfileName, string> = {
  fastbike: 'Fastbike',
  'fastbike-lowtraffic': 'Fastbike Low Traffic',
  'fastbike-verylowtraffic': 'Fastbike Very Low Traffic',
  'gabis-lite-gravel': "Gabi's Lite Gravel",
  'gabis-safe-road': "Gabi's Safe Road",
  gravel: 'Gravel',
  trekking: 'Trekking',
};

interface HeaderProps {
  profile: ProfileName;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onOpenAbout: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  profile,
  isCollapsed,
  onToggleCollapse,
  onOpenAbout,
}) => {
  return (
    <div
      className="header"
      onClick={() => {
        if (isCollapsed) onToggleCollapse();
      }}
    >
      <div className="header-top">
        <div className="header-title-wrap">
          <h1>GBRouter</h1>
          <span id="header-profile-badge" className="header-profile-badge">
            {PROFILE_LABELS[profile] || profile}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button
            id="btn-about"
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
            className="collapse-btn"
            title="Collapse or expand panel"
            aria-label="Collapse panel"
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse();
            }}
          >
            <Icon name="chevron-up" size={16} />
          </button>
        </div>
      </div>
      <p id="header-subtitle">Bike routing on your terms.</p>
    </div>
  );
};
