import React, { useMemo, useCallback, useState, useEffect } from 'react';
import type { Profile } from '../utils/geo.ts';
import { nearestIndex } from '../utils/geo.ts';
import type { SegmentHighlight, SegmentData } from '../utils/classification.ts';
import {
  classifySurface,
  classifyRoad,
  classifyTraffic,
  classifyNoise,
  classifySpeedLimit,
  SURFACE_META,
  ROAD_META,
  TRAFFIC_META,
  NOISE_META,
  SPEED_LIMIT_META,
} from '../utils/classification.ts';
import { formatDistance, type Units } from '../format.ts';
import { InfoButton } from './TooltipPopover.tsx';

interface SurfaceBreakdownProps {
  slotIdx?: number;
  profile: Profile | null;
  segments: SegmentData[];
  units: Units;
  onHover: (pos: { lon: number; lat: number } | null) => void;
  onHighlightSegment: (highlight: SegmentHighlight | null) => void;
}

interface StackedBarProps<T extends string> {
  rowKey: string;
  title: string;
  tooltip: string;
  ariaLabel: string;
  totalDist: number;
  segments: SegmentData[];
  classifier: (s: SegmentData) => T;
  meta: Record<T, { label: string; color: string }>;
  profile: Profile | null;
  pinnedKey: string | null;
  onTogglePin: (key: string, highlight: SegmentHighlight) => void;
  onHover: (pos: { lon: number; lat: number } | null) => void;
  onHighlightSegment: (highlight: SegmentHighlight | null) => void;
}

function StackedBarRow<T extends string>({
  rowKey,
  title,
  tooltip,
  ariaLabel,
  totalDist,
  segments,
  classifier,
  meta,
  profile,
  pinnedKey,
  onTogglePin,
  onHover,
  onHighlightSegment,
}: StackedBarProps<T>) {
  const { merged, categoryTotals } = useMemo(() => {
    const totals: Partial<Record<T, number>> = {};
    const m: Array<{ from: number; to: number; category: T }> = [];

    for (const s of segments) {
      const len = Math.max(0, s.to - s.from);
      if (len === 0) continue;
      const cat = classifier(s);
      totals[cat] = (totals[cat] || 0) + len;

      if (m.length > 0 && m[m.length - 1].category === cat) {
        m[m.length - 1].to = s.to;
      } else {
        m.push({ from: s.from, to: s.to, category: cat });
      }
    }
    return { merged: m, categoryTotals: totals };
  }, [segments, classifier]);

  const segmentCoordinates = useCallback(
    (fromM: number, toM: number): number[][] => {
      if (!profile || profile.coords.length < 2) return [];
      let i0 = nearestIndex(profile.dist, fromM);
      let i1 = nearestIndex(profile.dist, toM);
      if (i1 <= i0) {
        if (i0 < profile.coords.length - 1) {
          i1 = i0 + 1;
        } else {
          i0 = Math.max(0, profile.coords.length - 2);
          i1 = profile.coords.length - 1;
        }
      }
      return profile.coords.slice(i0, i1 + 1).map((pt) => [pt[0], pt[1]]);
    },
    [profile],
  );

  const buildCategoryHighlight = useCallback(
    (cat: T): SegmentHighlight | null => {
      const allCoords: number[][][] = [];
      for (const s of merged) {
        if (s.category === cat) {
          const c = segmentCoordinates(s.from, s.to);
          if (c.length >= 2) allCoords.push(c);
        }
      }
      if (allCoords.length === 0) return null;
      return {
        coordinates: allCoords,
        color: meta[cat].color,
      };
    },
    [merged, meta, segmentCoordinates],
  );

  const handleBarPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!profile) return;
    const box = e.currentTarget.getBoundingClientRect();
    const total = profile.dist[profile.dist.length - 1] || 1;
    const d = Math.min(total, Math.max(0, ((e.clientX - box.left) / box.width) * total));
    const i = nearestIndex(profile.dist, d);
    onHover({ lon: profile.coords[i][0], lat: profile.coords[i][1] });
  };

  const handleBarPointerLeave = () => {
    onHover(null);
    onHighlightSegment(null);
  };

  const cats = (Object.keys(meta) as T[]).filter((c) => (categoryTotals[c] || 0) > 0);

  return (
    <div className="profile-bar-row">
      <div className="profile-bar-header">
        <span className="profile-bar-title">
          {title} <InfoButton tooltip={tooltip} ariaLabel={ariaLabel} />
        </span>
        <div className="profile-bar-legend">
          {cats.map((cat) => {
            const dist = categoryTotals[cat] || 0;
            const pct = Math.round((dist / totalDist) * 100);
            if (pct < 1 && dist < 100) return null;
            const itemKey = `${rowKey}:${cat}`;
            const isPinned = pinnedKey === itemKey;

            return (
              <span
                key={cat}
                role="button"
                tabIndex={0}
                className={`surface-legend-item ${isPinned ? 'active' : ''}`}
                title={`${meta[cat].label}: ${formatDistance(dist)} (${pct}%) - Click to pin on map`}
                onPointerEnter={() => {
                  const hl = buildCategoryHighlight(cat);
                  if (hl) onHighlightSegment(hl);
                }}
                onPointerLeave={() => onHighlightSegment(null)}
                onClick={() => {
                  const hl = buildCategoryHighlight(cat);
                  if (hl) onTogglePin(itemKey, hl);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    const hl = buildCategoryHighlight(cat);
                    if (hl) onTogglePin(itemKey, hl);
                  }
                }}
              >
                <span className="surface-swatch" style={{ backgroundColor: meta[cat].color }}></span>
                <span>{`${meta[cat].label} ${pct}%`}</span>
              </span>
            );
          })}
        </div>
      </div>

      <div
        className="surface-bar"
        role="img"
        aria-label={ariaLabel}
        onPointerMove={handleBarPointerMove}
        onPointerLeave={handleBarPointerLeave}
      >
        {merged.map((seg, i) => {
          const widthPct = Math.max(0.1, ((seg.to - seg.from) / totalDist) * 100);
          return (
            <div
              key={i}
              className="surface-segment"
              style={{
                width: `${widthPct.toFixed(2)}%`,
                backgroundColor: meta[seg.category].color,
              }}
              title={`${meta[seg.category].label}: ${formatDistance(seg.to - seg.from)}`}
              onPointerEnter={() => {
                const coords = segmentCoordinates(seg.from, seg.to);
                if (coords.length >= 2) {
                  onHighlightSegment({
                    coordinates: [coords],
                    color: meta[seg.category].color,
                  });
                }
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

export const SurfaceBreakdown: React.FC<SurfaceBreakdownProps> = ({
  slotIdx = 0,
  profile,
  segments,
  units: _units,
  onHover,
  onHighlightSegment,
}) => {
  const [pinned, setPinned] = useState<{ key: string; highlight: SegmentHighlight } | null>(null);

  useEffect(() => {
    setPinned(null);
  }, [profile, segments]);

  const handleHighlight = useCallback(
    (hl: SegmentHighlight | null) => {
      if (hl) {
        onHighlightSegment(hl);
      } else {
        onHighlightSegment(pinned ? pinned.highlight : null);
      }
    },
    [onHighlightSegment, pinned],
  );

  const handleTogglePin = useCallback(
    (key: string, highlight: SegmentHighlight) => {
      setPinned((prev) => {
        if (prev?.key === key) {
          onHighlightSegment(null);
          return null;
        }
        onHighlightSegment(highlight);
        return { key, highlight };
      });
    },
    [onHighlightSegment],
  );

  if (!profile || segments.length === 0) return null;
  const total = profile.dist[profile.dist.length - 1] || 1;
  const domId = slotIdx === 0 ? 'surface-section' : `surface-section-${slotIdx}`;

  return (
    <div id={domId} className="surface-section">
      <StackedBarRow
        rowKey="surface"
        title="Surface"
        tooltip="Road surface material from OpenStreetMap. Click any category to pin its segments on the map."
        ariaLabel="Surface types"
        totalDist={total}
        segments={segments}
        classifier={(s) => classifySurface(s.surface, s.highway)}
        meta={SURFACE_META}
        profile={profile}
        pinnedKey={pinned?.key ?? null}
        onTogglePin={handleTogglePin}
        onHover={onHover}
        onHighlightSegment={handleHighlight}
      />
      <StackedBarRow
        rowKey="road"
        title="Road Type"
        tooltip="Highway classification from OpenStreetMap. Separates protected cycleways and quiet residential streets from major roads."
        ariaLabel="Road types"
        totalDist={total}
        segments={segments}
        classifier={(s) => classifyRoad(s.highway)}
        meta={ROAD_META}
        profile={profile}
        pinnedKey={pinned?.key ?? null}
        onTogglePin={handleTogglePin}
        onHover={onHover}
        onHighlightSegment={handleHighlight}
      />
      <StackedBarRow
        rowKey="traffic"
        title="Traffic"
        tooltip="Estimated motor vehicle volume based on road classification and BRouter traffic density tags."
        ariaLabel="Traffic levels"
        totalDist={total}
        segments={segments}
        classifier={(s) => classifyTraffic(s.traffic, s.highway)}
        meta={TRAFFIC_META}
        profile={profile}
        pinnedKey={pinned?.key ?? null}
        onTogglePin={handleTogglePin}
        onHover={onHover}
        onHighlightSegment={handleHighlight}
      />
      <StackedBarRow
        rowKey="noise"
        title="Noise &amp; pollution"
        tooltip="Modeled noise and air pollution exposure based on proximity to motorways, trunk roads, primary roads, and flight paths."
        ariaLabel="Noise and pollution levels"
        totalDist={total}
        segments={segments}
        classifier={(s) => classifyNoise(s.noise)}
        meta={NOISE_META}
        profile={profile}
        pinnedKey={pinned?.key ?? null}
        onTogglePin={handleTogglePin}
        onHover={onHover}
        onHighlightSegment={handleHighlight}
      />
      <StackedBarRow
        rowKey="speed"
        title="Speed Limit"
        tooltip="Posted motor vehicle speed limits along the route, plus car-free tracks and cycle paths."
        ariaLabel="Speed limits"
        totalDist={total}
        segments={segments}
        classifier={(s) => classifySpeedLimit(s.maxspeed, s.highway)}
        meta={SPEED_LIMIT_META}
        profile={profile}
        pinnedKey={pinned?.key ?? null}
        onTogglePin={handleTogglePin}
        onHover={onHover}
        onHighlightSegment={handleHighlight}
      />
    </div>
  );
};
