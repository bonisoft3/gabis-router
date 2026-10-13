import React, { useMemo } from 'react';
import type { SegmentHighlight, SegmentData } from '../utils/classification.ts';
import type { ComparedRoute } from '../utils/gpx.ts';
import { formatDistance, formatDuration, formatElevation, type Units } from '../format.ts';
import { buildProfile } from '../utils/geo.ts';
import { ElevationChart } from './ElevationChart.tsx';
import { SurfaceBreakdown } from './SurfaceBreakdown.tsx';
import { CollapsibleDetails } from './common/CollapsibleDetails.tsx';
import { Icon } from './common/Icon.tsx';

interface RouteInfoDrawerProps {
  currentRoute: GeoJSON.FeatureCollection | null;
  comparedRoute: ComparedRoute | null;
  units: Units;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onHoverPosition: (pos: { lon: number; lat: number } | null) => void;
  onHighlightSegment: (highlight: SegmentHighlight | null) => void;
}

export const RouteInfoDrawer: React.FC<RouteInfoDrawerProps> = ({
  currentRoute,
  comparedRoute,
  units,
  isCollapsed,
  onToggleCollapse,
  onHoverPosition,
  onHighlightSegment,
}) => {
  const routeData = useMemo(() => {
    if (!currentRoute || currentRoute.features.length === 0) return null;
    const feat = currentRoute.features[0];
    const props = (feat.properties || {}) as Record<string, any>;
    const coords = (feat.geometry as GeoJSON.LineString).coordinates;
    const prof = buildProfile(coords);
    const segs: SegmentData[] = props.segments || [];

    const ascent = Number(props['filtered ascend'] || 0);
    const net = prof.ele[prof.ele.length - 1] - prof.ele[0];
    const descent = Math.max(0, ascent - net);

    return {
      distance: Number(props['track-length'] || 0),
      time: Number(props['total-time'] || 0),
      ascent,
      descent,
      profile: prof,
      segments: segs,
    };
  }, [currentRoute]);

  if (!routeData) return null;

  return (
    <div id="route-info" className={isCollapsed ? 'collapsed' : ''}>
      <div
        className="ri-stats"
        onClick={() => {
          if (isCollapsed) onToggleCollapse();
        }}
      >
        <div className="ri-stat-group">
          <div className="ri-stat">
            <span id="ri-distance">{formatDistance(routeData.distance)}</span>
            <small>Distance</small>
          </div>
          <div className="ri-stat">
            <span id="ri-time">{formatDuration(routeData.time)}</span>
            <small>Time</small>
          </div>
          <div className="ri-stat">
            <span id="ri-ascent">{formatElevation(routeData.ascent)}</span>
            <small>Ascent</small>
          </div>
          <div className="ri-stat">
            <span id="ri-descent">{formatElevation(routeData.descent)}</span>
            <small>Descent</small>
          </div>
        </div>

        <div className="ri-actions">
          <button
            id="btn-toggle-ri-collapse"
            className="collapse-btn"
            title={isCollapsed ? 'Expand details' : 'Collapse details'}
            aria-label={isCollapsed ? 'Expand details' : 'Collapse details'}
            aria-expanded={!isCollapsed}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse();
            }}
          >
            <Icon id="ri-collapse-icon" name="chevron-up" size={16} />
          </button>
        </div>
      </div>

      <div id="route-info-body">
        <CollapsibleDetails
          id="elevation-details"
          title="Elevation Profile"
          tooltip="Height above sea level sampled from terrain elevation data. Gradients are calculated over 40-metre windows. Bridge elevations over water are not accurately measured."
          tooltipAriaLabel="About Elevation Profile"
          defaultOpen={true}
        >
          <ElevationChart
            profile={routeData.profile}
            segments={routeData.segments}
            comparedRoute={comparedRoute}
            units={units}
            onHover={onHoverPosition}
          />
        </CollapsibleDetails>

        {routeData.segments.length > 0 && (
          <CollapsibleDetails
            id="surface-details"
            title="Surface &amp; Road Breakdown"
            defaultOpen={true}
          >
            <SurfaceBreakdown
              profile={routeData.profile}
              segments={routeData.segments}
              units={units}
              onHover={onHoverPosition}
              onHighlightSegment={onHighlightSegment}
            />
          </CollapsibleDetails>
        )}

        <div id="ri-attribution" className="ri-attribution">
          © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>
        </div>
      </div>
    </div>
  );
};
