import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import type { Profile } from '../utils/geo.ts';
import { formatDistance, formatElevation, type Units } from '../format.ts';
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
import { gradeAt, gradeColor, nearestIndex, nearestVertex } from '../utils/geo.ts';

const CHART_HEIGHT = 100;
const COMPACT_CHART_HEIGHT = 74;
const CHART_PAD = { top: 8, bottom: 15, left: 4, right: 4 };

interface ElevationChartProps {
  slotIdx?: number;
  compact?: boolean;
  areaColor?: string;
  profile: Profile | null;
  segments: any[];
  units: Units;
  hoverPosition?: { lon: number; lat: number } | null;
  onHover: (pos: { lon: number; lat: number } | null) => void;
}

interface HoverDetails {
  cx: number;
  cy: number;
  distStr: string;
  eleStr: string;
  gradeStr: string;
  gradeColor: string;
  surfLabel: string;
  surfColor: string;
  roadLabel: string;
  roadColor: string;
  trafficLabel: string;
  trafficColor: string;
  noiseLabel: string;
  speedLimitLabel: string;
}

export const ElevationChart: React.FC<ElevationChartProps> = ({
  slotIdx = 0,
  compact = false,
  areaColor,
  profile,
  segments,
  units: _units,
  hoverPosition,
  onHover,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(() =>
    typeof window !== 'undefined' && window.innerWidth > 860
      ? Math.max(260, Math.round((window.innerWidth - 432) * 0.46))
      : 300,
  );
  const [localHoverIdx, setLocalHoverIdx] = useState<number | null>(null);

  const chartHeight = compact ? COMPACT_CHART_HEIGHT : CHART_HEIGHT;
  const gradId = `ec-grade-grad-${slotIdx}`;
  const domId = slotIdx === 0 ? 'elevation-chart' : `elevation-chart-${slotIdx}`;

  useEffect(() => {
    if (!containerRef.current) return;
    const updateWidth = () => {
      const cw = containerRef.current?.clientWidth || 0;
      if (cw > 0) {
        setContainerWidth(Math.max(240, cw));
        return;
      }
      const rootW = document.getElementById('root')?.clientWidth || window.innerWidth;
      if (rootW <= 860) {
        setContainerWidth(Math.max(240, rootW - 40));
      } else {
        setContainerWidth(Math.max(260, Math.round((rootW - 432) * 0.46)));
      }
    };
    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(containerRef.current);
    const drawerEl = document.getElementById('route-info');
    const mo = new MutationObserver(updateWidth);
    if (drawerEl) {
      mo.observe(drawerEl, { attributes: true, attributeFilter: ['class'] });
    }
    window.addEventListener('resize', updateWidth);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', updateWidth);
    };
  }, []);

  const attributesAt = useCallback(
    (d: number) => {
      if (!segments || segments.length === 0) {
        return {
          surfLabel: '',
          surfColor: '#94a3b8',
          roadLabel: '',
          roadColor: '#94a3b8',
          trafficLabel: '',
          trafficColor: '#94a3b8',
          noiseLabel: '',
          speedLimitLabel: '',
        };
      }
      let target = segments[segments.length - 1];
      for (const seg of segments) {
        if (d >= seg.from && d <= seg.to) {
          target = seg;
          break;
        }
      }
      const sCat = classifySurface(target.surface, target.highway);
      const rCat = classifyRoad(target.highway);
      const tCat = classifyTraffic(target.traffic, target.highway);
      const nCat = classifyNoise(target.noise);
      const spCat = classifySpeedLimit(target.maxspeed, target.highway);
      const rawSurf = target.surface ? ` (${target.surface})` : '';
      return {
        surfLabel: `${SURFACE_META[sCat].label}${rawSurf}`,
        surfColor: SURFACE_META[sCat].color,
        roadLabel: ROAD_META[rCat].label,
        roadColor: ROAD_META[rCat].color,
        trafficLabel: `Traffic: ${TRAFFIC_META[tCat].label}`,
        trafficColor: TRAFFIC_META[tCat].color,
        noiseLabel: `Noise: ${NOISE_META[nCat].label}`,
        speedLimitLabel: SPEED_LIMIT_META[spCat].label,
      };
    },
    [segments],
  );

  useEffect(() => {
    setLocalHoverIdx(null);
  }, [profile]);

  const validProfile = !!(
    profile &&
    profile.ele.length > 0 &&
    !profile.ele.some((e) => e === undefined || Number.isNaN(e))
  );

  const total = validProfile && profile ? profile.dist[profile.dist.length - 1] || 1 : 1;

  const gradientStops = useMemo(() => {
    if (!validProfile || !profile) return [];
    const { dist, ele } = profile;
    const maxStops = 90;
    const step = Math.max(1, Math.floor(dist.length / maxStops));
    const stops: Array<{ offset: string; color: string }> = [];
    for (let i = 0; i < dist.length; i += step) {
      const pct = Math.max(0, Math.min(100, (dist[i] / total) * 100));
      stops.push({
        offset: `${pct.toFixed(2)}%`,
        color: gradeColor(gradeAt(dist, ele, i)),
      });
    }
    if (dist.length > 1 && (dist.length - 1) % step !== 0) {
      const last = dist.length - 1;
      const pct = Math.max(0, Math.min(100, (dist[last] / total) * 100));
      stops.push({
        offset: `${pct.toFixed(2)}%`,
        color: gradeColor(gradeAt(dist, ele, last)),
      });
    }
    return stops;
  }, [validProfile, profile, total]);

  if (!validProfile || !profile) {
    return (
      <div id={domId} className="elevation-chart" ref={containerRef}>
        No elevation data for this route.
      </div>
    );
  }

  const { dist, ele, coords } = profile;

  const width = containerWidth;
  let minEle = Infinity;
  let maxEle = -Infinity;
  for (let i = 0; i < ele.length; i++) {
    if (ele[i] < minEle) minEle = ele[i];
    if (ele[i] > maxEle) maxEle = ele[i];
  }
  const span = Math.max(maxEle - minEle, 20);
  const plotW = width - CHART_PAD.left - CHART_PAD.right;
  const plotH = chartHeight - CHART_PAD.top - CHART_PAD.bottom;
  const x = (d: number) => CHART_PAD.left + (d / total) * plotW;
  const y = (e: number) => CHART_PAD.top + plotH - ((e - minEle) / span) * plotH;

  const lineD = dist
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${x(d).toFixed(1)},${y(ele[i]).toFixed(1)}`)
    .join(' ');
  const areaD = `${lineD} L${x(dist[dist.length - 1] || total).toFixed(1)},${
    CHART_PAD.top + plotH
  } L${x(0).toFixed(1)},${CHART_PAD.top + plotH} Z`;

  const midEle = minEle + span * 0.5;

  // Determine active index from either local chart pointer or external hoverPosition (route / surface bar)
  let activeIdx: number | null = localHoverIdx;
  if (activeIdx === null && hoverPosition && coords.length > 0) {
    activeIdx = nearestVertex(coords, hoverPosition.lon, hoverPosition.lat);
  }

  let hoverState: HoverDetails | null = null;
  if (activeIdx !== null && activeIdx >= 0 && activeIdx < dist.length) {
    const i = activeIdx;
    const cx = x(dist[i]);
    const cy = y(ele[i]);
    const grade = gradeAt(dist, ele, i);
    const gColor = gradeColor(grade);
    const attrs = attributesAt(dist[i]);

    hoverState = {
      cx,
      cy,
      distStr: formatDistance(dist[i]),
      eleStr: formatElevation(ele[i]),
      gradeStr: `${grade >= 0 ? '+' : ''}${grade.toFixed(1)}%`,
      gradeColor: gColor,
      ...attrs,
    };
  }

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const d = Math.min(
      total,
      Math.max(0, ((e.clientX - box.left - CHART_PAD.left) / plotW) * total),
    );
    const i = nearestIndex(dist, Math.min(dist[dist.length - 1], d));
    setLocalHoverIdx(i);
    onHover({ lon: coords[i][0], lat: coords[i][1] });
  };

  const handlePointerLeave = () => {
    setLocalHoverIdx(null);
    onHover(null);
  };

  return (
    <div
      id={domId}
      className={`elevation-chart ${compact ? 'is-compact' : ''}`}
      ref={containerRef}
    >
      {hoverState && (
        <div className="ec-readout">
          <div className="ec-readout-active">
            <span className="ec-readout-primary">
              <strong>{hoverState.eleStr}</strong>
              <span
                className="ec-grade-pill"
                style={{ backgroundColor: hoverState.gradeColor }}
              >
                {hoverState.gradeStr}
              </span>
              <span className="ec-readout-dist">{hoverState.distStr}</span>
            </span>
            {hoverState.surfLabel && (
              <span className="ec-readout-tags">
                <span className="ec-tag">
                  <span
                    className="ec-tag-dot"
                    style={{ backgroundColor: hoverState.surfColor }}
                  />
                  {hoverState.surfLabel}
                </span>
                <span className="ec-tag">
                  <span
                    className="ec-tag-dot"
                    style={{ backgroundColor: hoverState.roadColor }}
                  />
                  {hoverState.roadLabel}
                </span>
                <span className="ec-tag">
                  <span
                    className="ec-tag-dot"
                    style={{ backgroundColor: hoverState.trafficColor }}
                  />
                  {hoverState.trafficLabel}
                </span>
                <span className="ec-tag">{hoverState.noiseLabel}</span>
                <span className="ec-tag">{hoverState.speedLimitLabel}</span>
              </span>
            )}
          </div>
        </div>
      )}

      <svg
        width={width}
        height={chartHeight}
        viewBox={`0 0 ${width} ${chartHeight}`}
        role="img"
        aria-label="Elevation along the route"
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onPointerCancel={handlePointerLeave}
      >
        <defs>
          <linearGradient
            id={gradId}
            gradientUnits="userSpaceOnUse"
            x1={CHART_PAD.left}
            y1={0}
            x2={CHART_PAD.left + plotW}
            y2={0}
          >
            {gradientStops.map((s, idx) => (
              <stop key={idx} offset={s.offset} stopColor={s.color} />
            ))}
          </linearGradient>
        </defs>

        {/* Horizontal grid lines */}
        <line
          className="ec-grid"
          x1={CHART_PAD.left}
          x2={CHART_PAD.left + plotW}
          y1={CHART_PAD.top}
          y2={CHART_PAD.top}
        />
        <line
          className="ec-grid"
          x1={CHART_PAD.left}
          x2={CHART_PAD.left + plotW}
          y1={y(midEle)}
          y2={y(midEle)}
        />
        <line
          className="ec-grid"
          x1={CHART_PAD.left}
          x2={CHART_PAD.left + plotW}
          y1={CHART_PAD.top + plotH}
          y2={CHART_PAD.top + plotH}
        />

        <path d={areaD} className="ec-area" style={areaColor ? { fill: areaColor } : undefined} />
        <path d={lineD} className="ec-line" style={{ stroke: `url(#${gradId})` }} />

        {/* Elevation min/max and distance labels */}
        <text x={CHART_PAD.left + 2} y={CHART_PAD.top + 9} className="ec-label" textAnchor="start">
          {formatElevation(maxEle)}
        </text>
        <text
          x={CHART_PAD.left + 2}
          y={CHART_PAD.top + plotH - 3}
          className="ec-label"
          textAnchor="start"
        >
          {formatElevation(minEle)}
        </text>
        <text x={CHART_PAD.left} y={chartHeight - 3} className="ec-label" textAnchor="start">
          {formatDistance(0)}
        </text>
        <text
          x={width * 0.5}
          y={chartHeight - 3}
          className="ec-label"
          textAnchor="middle"
        >
          {formatDistance(total * 0.5)}
        </text>
        <text
          x={width - CHART_PAD.right}
          y={chartHeight - 3}
          className="ec-label"
          textAnchor="end"
        >
          {formatDistance(total)}
        </text>

        {/* Hover cursor and point dot */}
        {hoverState && (
          <>
            <line
              className="ec-cursor"
              x1={hoverState.cx}
              x2={hoverState.cx}
              y1={CHART_PAD.top}
              y2={CHART_PAD.top + plotH}
            />
            <circle
              className="ec-cursor-dot"
              cx={hoverState.cx}
              cy={hoverState.cy}
              r={4}
              fill={hoverState.gradeColor}
            />
          </>
        )}
      </svg>
    </div>
  );
};
