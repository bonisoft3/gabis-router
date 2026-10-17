import React, { useMemo, useState, useEffect, useRef } from 'react';
import {
  PROFILE_INFO,
  ROUTE_SLOT_COLORS,
  type RouteSlotState,
} from '../types.ts';
import type { SegmentHighlight, SegmentData } from '../utils/classification.ts';
import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatSpeed,
  type Units,
} from '../format.ts';
import { buildProfile } from '../utils/geo.ts';
import { ElevationChart } from './ElevationChart.tsx';
import { SurfaceBreakdown } from './SurfaceBreakdown.tsx';
import { InfoButton } from './TooltipPopover.tsx';
import { Icon } from './common/Icon.tsx';

const ALTERNATIVES = [
  { idx: 0, label: 'Primary', shortLabel: 'Route 1' },
  { idx: 1, label: 'Alt 2', shortLabel: 'Alt 2' },
  { idx: 2, label: 'Alt 3', shortLabel: 'Alt 3' },
  { idx: 3, label: 'Alt 4', shortLabel: 'Alt 4' },
];

interface RouteInfoDrawerProps {
  slots: RouteSlotState[];
  units: Units;
  onSelectSlotAlternative: (slotIdx: number, altIdx: number) => void;
  onRemoveSlot?: (slotIdx: number) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  hoverPosition?: { lon: number; lat: number } | null;
  onHoverPosition: (pos: { lon: number; lat: number } | null) => void;
  onHighlightSegment: (highlight: SegmentHighlight | null) => void;
}

interface ParsedSlotData {
  distance: number;
  time: number;
  ascent: number;
  descent: number;
  profile: ReturnType<typeof buildProfile>;
  segments: SegmentData[];
}

function parseRouteFeatureCollection(
  route: GeoJSON.FeatureCollection | null,
): ParsedSlotData | null {
  if (!route || route.features.length === 0) return null;
  const feat = route.features[0];
  const props = (feat.properties || {}) as Record<string, any>;
  const coords = (feat.geometry as GeoJSON.LineString).coordinates;
  const prof = buildProfile(coords);
  const segs: SegmentData[] = props.segments || [];

  const ascent = Number(props['filtered ascend'] || 0);
  const net = prof.ele.length > 0 ? prof.ele[prof.ele.length - 1] - prof.ele[0] : 0;
  const descent = Math.max(0, ascent - net);

  return {
    distance: Number(props['track-length'] || 0),
    time: Number(props['total-time'] || 0),
    ascent,
    descent,
    profile: prof,
    segments: segs,
  };
}

export const RouteInfoDrawer: React.FC<RouteInfoDrawerProps> = ({
  slots,
  units,
  onSelectSlotAlternative,
  onRemoveSlot,
  isCollapsed,
  onToggleCollapse,
  hoverPosition,
  onHoverPosition,
  onHighlightSegment,
}) => {
  const [collapsedBySlot, setCollapsedBySlot] = useState<Record<number, boolean>>({
    0: isCollapsed,
    1: isCollapsed,
    2: isCollapsed,
  });
  const internalToggleRef = useRef<boolean>(false);

  useEffect(() => {
    if (internalToggleRef.current) {
      internalToggleRef.current = false;
      return;
    }
    setCollapsedBySlot({
      0: isCollapsed,
      1: isCollapsed,
      2: isCollapsed,
    });
  }, [isCollapsed]);

  const parsedSlots = useMemo(
    () => slots.map((slot) => parseRouteFeatureCollection(slot.route)),
    [slots],
  );

  const hasAnyRoute = parsedSlots.some((d) => d !== null);
  if (!hasAnyRoute) return null;

  const isMultiSlot = slots.length > 1;
  const allCollapsed = slots.every((_, idx) => Boolean(collapsedBySlot[idx]));

  const handleToggleSlot = (slotIdx: number) => {
    const nextVal = !Boolean(collapsedBySlot[slotIdx]);
    const next = { ...collapsedBySlot, [slotIdx]: nextVal };
    setCollapsedBySlot(next);
    const nextAllCollapsed = slots.every((_, idx) => Boolean(next[idx]));
    if (nextAllCollapsed !== isCollapsed) {
      internalToggleRef.current = true;
      onToggleCollapse();
    }
  };

  return (
    <div
      id="route-info"
      className={`${allCollapsed ? 'collapsed' : ''} ${isMultiSlot ? 'multi-slot' : ''}`}
    >
      {slots.map((slot, slotIdx) => {
        const routeData = parsedSlots[slotIdx];
        if (!routeData && !slot.isRouting) return null;

        const slotColor = ROUTE_SLOT_COLORS[slotIdx] || ROUTE_SLOT_COLORS[0];
        const profileMeta = PROFILE_INFO[slot.profile];
        const barCollapsed = Boolean(collapsedBySlot[slotIdx]);

        return (
          <div
            key={slotIdx}
            id={slotIdx === 0 ? 'route-bar-0' : `route-bar-${slotIdx}`}
            className={`route-bar-card ${barCollapsed ? 'collapsed' : ''}`}
            style={{ '--slot-color': slotColor.line } as React.CSSProperties}
          >
            <div
              className="ri-bar-header"
              onClick={() => handleToggleSlot(slotIdx)}
            >
              <div className="ri-bar-identity">
                <span
                  className="ri-slot-dot"
                  style={{ backgroundColor: slotColor.line }}
                  title={`Route ${slotIdx + 1} (${slotColor.name})`}
                />
                <span className="ri-slot-title" title={profileMeta?.summary}>
                  {profileMeta?.label || slot.profile}
                </span>
              </div>

              {routeData ? (
                <div className="ri-bar-metrics">
                  <div className="ri-stat">
                    <span id={slotIdx === 0 ? 'ri-distance' : `ri-distance-${slotIdx}`}>
                      {formatDistance(routeData.distance)}
                    </span>
                    <small>Distance</small>
                  </div>
                  <div className="ri-stat">
                    <span id={slotIdx === 0 ? 'ri-time' : `ri-time-${slotIdx}`}>
                      {formatDuration(routeData.time)}
                    </span>
                    <small>Est. Time</small>
                  </div>
                  <div className="ri-stat">
                    <span id={slotIdx === 0 ? 'ri-ascent' : `ri-ascent-${slotIdx}`}>
                      {formatElevation(routeData.ascent)}
                    </span>
                    <small>Ascent</small>
                  </div>
                  <div className="ri-stat">
                    <span id={slotIdx === 0 ? 'ri-descent' : `ri-descent-${slotIdx}`}>
                      {formatElevation(routeData.descent)}
                    </span>
                    <small>Descent</small>
                  </div>
                  <div className="ri-stat">
                    <span id={slotIdx === 0 ? 'ri-speed' : `ri-speed-${slotIdx}`}>
                      {formatSpeed(routeData.distance, routeData.time)}
                    </span>
                    <small>Avg Speed</small>
                  </div>
                </div>
              ) : (
                <div className="ri-bar-loading">
                  <span className="status-spinner" aria-hidden="true" />
                  <span>Calculating route...</span>
                </div>
              )}

              <div
                className="ri-bar-controls"
                onClick={(e) => {
                  e.stopPropagation();
                }}
              >
                <div className="ri-alternatives" role="group" aria-label="Route alternatives">
                  {ALTERNATIVES.map((alt) => (
                    <button
                      key={alt.idx}
                      type="button"
                      className={`ri-alt-btn ${slot.alternativeIdx === alt.idx ? 'active' : ''}`}
                      title={`Compute ${alt.label} route for ${profileMeta?.label || slot.profile}`}
                      onClick={() => onSelectSlotAlternative(slotIdx, alt.idx)}
                    >
                      {alt.shortLabel}
                    </button>
                  ))}
                </div>

                <button
                  id={slotIdx === 0 ? 'btn-toggle-ri-collapse' : `btn-toggle-ri-collapse-${slotIdx}`}
                  type="button"
                  className="collapse-btn ri-bar-collapse-btn"
                  title={barCollapsed ? 'Expand charts' : 'Collapse charts'}
                  aria-label={barCollapsed ? 'Expand charts' : 'Collapse charts'}
                  aria-expanded={!barCollapsed}
                  onClick={() => handleToggleSlot(slotIdx)}
                >
                  <Icon
                    id={slotIdx === 0 ? 'ri-collapse-icon' : undefined}
                    className="ri-collapse-chevron"
                    name="chevron-down"
                    size={15}
                  />
                </button>

                {isMultiSlot && onRemoveSlot && (
                  <button
                    type="button"
                    className="collapse-btn ri-bar-remove-btn"
                    title="Remove this profile from comparison"
                    aria-label={`Remove ${profileMeta?.label || slot.profile}`}
                    onClick={() => onRemoveSlot(slotIdx)}
                  >
                    <Icon name="close" size={14} />
                  </button>
                )}
              </div>
            </div>

            {routeData && !barCollapsed && (
              <div
                id={slotIdx === 0 ? 'route-info-body' : `route-info-body-${slotIdx}`}
                className="ri-bar-body"
              >
                <div
                  id={slotIdx === 0 ? 'elevation-details' : `elevation-details-${slotIdx}`}
                  className="ri-col ri-col-elevation"
                >
                  <div className="ri-col-header">
                    <span className="ri-col-title">
                      Elevation Profile
                      <InfoButton
                        tooltip="Height above sea level sampled from terrain elevation data. Gradients are calculated over 40-metre windows. Bridge elevations over water are not accurately measured."
                        ariaLabel="About Elevation Profile"
                      />
                    </span>
                  </div>
                  <ElevationChart
                    slotIdx={slotIdx}
                    compact={isMultiSlot}
                    areaColor={slotColor.soft}
                    profile={routeData.profile}
                    segments={routeData.segments}
                    units={units}
                    hoverPosition={hoverPosition}
                    onHover={onHoverPosition}
                  />
                </div>

                {routeData.segments.length > 0 && (
                  <div
                    id={slotIdx === 0 ? 'surface-details' : `surface-details-${slotIdx}`}
                    className="ri-col ri-col-surface"
                  >
                    <div className="ri-col-header">
                      <span className="ri-col-title">Surface &amp; Road Breakdown</span>
                    </div>
                    <SurfaceBreakdown
                      slotIdx={slotIdx}
                      profile={routeData.profile}
                      segments={routeData.segments}
                      units={units}
                      onHover={onHoverPosition}
                      onHighlightSegment={onHighlightSegment}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
