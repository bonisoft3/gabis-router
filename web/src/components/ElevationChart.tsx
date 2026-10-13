import React, { useRef, useState, useEffect, useCallback } from 'react';
import type { Profile } from '../utils/geo.ts';
import type { ComparedRoute } from '../utils/gpx.ts';
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
import { gradeAt, gradeColor, nearestIndex } from '../utils/geo.ts';

const CHART_HEIGHT = 96;
const CHART_PAD = { top: 8, bottom: 16, left: 4, right: 4 };

interface ElevationChartProps {
  profile: Profile | null;
  segments: any[];
  comparedRoute: ComparedRoute | null;
  units: Units;
  onHover: (pos: { lon: number; lat: number } | null) => void;
}

export const ElevationChart: React.FC<ElevationChartProps> = ({
  profile,
  segments,
  comparedRoute,
  units: _units,
  onHover,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(300);
  const [hoverState, setHoverState] = useState<{
    cx: number;
    tipText: string;
    flip: boolean;
  } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerWidth(Math.max(240, containerRef.current.clientWidth));
      }
    };
    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(containerRef.current);
    window.addEventListener('resize', updateWidth);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateWidth);
    };
  }, []);

  const attributesAt = useCallback(
    (d: number) => {
      if (!segments || segments.length === 0) {
        return { surfLabel: '', surfDetail: '', roadLabel: '', trafficLabel: '', noiseLabel: '', speedLimitLabel: '' };
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
      const trafficClassStr = target.traffic ? ` (class ${target.traffic})` : '';
      const noiseClassStr = target.noise ? ` (class ${target.noise})` : '';
      return {
        surfLabel: SURFACE_META[sCat].label,
        surfDetail: target.surface || target.highway,
        roadLabel: ROAD_META[rCat].label,
        trafficLabel: `${TRAFFIC_META[tCat].label}${trafficClassStr}`,
        noiseLabel: `${NOISE_META[nCat].label}${noiseClassStr}`,
        speedLimitLabel: SPEED_LIMIT_META[spCat].label,
      };
    },
    [segments],
  );

  if (!profile || profile.ele.some((e) => e === undefined || Number.isNaN(e))) {
    return (
      <div id="elevation-chart" ref={containerRef}>
        No elevation data for this route.
      </div>
    );
  }

  const { dist, ele, coords } = profile;
  const cmpDist = comparedRoute?.dist;
  const cmpEle = comparedRoute?.ele;
  const hasCmp = !!(cmpDist && cmpEle && cmpDist.length > 1 && cmpEle.length > 1);

  const width = containerWidth;
  const total = Math.max(dist[dist.length - 1] || 1, hasCmp ? cmpDist[cmpDist.length - 1] : 0);
  let minEle = Math.min(...ele);
  let maxEle = Math.max(...ele);
  if (hasCmp && cmpEle.length > 0) {
    minEle = Math.min(minEle, Math.min(...cmpEle));
    maxEle = Math.max(maxEle, Math.max(...cmpEle));
  }
  const span = Math.max(maxEle - minEle, 20);
  const plotW = width - CHART_PAD.left - CHART_PAD.right;
  const plotH = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom;
  const x = (d: number) => CHART_PAD.left + (d / total) * plotW;
  const y = (e: number) => CHART_PAD.top + plotH - ((e - minEle) / span) * plotH;

  const lineD = dist.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(d).toFixed(1)},${y(ele[i]).toFixed(1)}`).join(' ');
  const areaD = `${lineD} L${x(dist[dist.length - 1] || total).toFixed(1)},${CHART_PAD.top + plotH} L${x(0).toFixed(1)},${CHART_PAD.top + plotH} Z`;

  let cmpLineD = '';
  if (hasCmp) {
    cmpLineD = cmpDist.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(d).toFixed(1)},${y(cmpEle[i]).toFixed(1)}`).join(' ');
  }

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const d = Math.min(total, Math.max(0, ((e.clientX - box.left - CHART_PAD.left) / plotW) * total));
    const i = nearestIndex(dist, Math.min(dist[dist.length - 1], d));
    const cx = x(dist[i]);
    const grade = gradeAt(dist, ele, i);
    const attrs = attributesAt(dist[i]);

    const surfStr = attrs.surfLabel
      ? `  •  ${attrs.surfDetail ? `${attrs.surfLabel} (${attrs.surfDetail})` : attrs.surfLabel}`
      : '';
    const roadStr = attrs.roadLabel ? `  •  ${attrs.roadLabel}` : '';
    const trafficStr = attrs.trafficLabel ? `  •  Traffic: ${attrs.trafficLabel}` : '';
    const noiseStr = attrs.noiseLabel ? `  •  Noise & pollution: ${attrs.noiseLabel}` : '';
    const speedStr = attrs.speedLimitLabel ? `  •  Speed: ${attrs.speedLimitLabel}` : '';
    let cmpStr = '';
    if (hasCmp) {
      const cmpI = nearestIndex(cmpDist, Math.min(cmpDist[cmpDist.length - 1], d));
      cmpStr = `  •  GPX: ${formatElevation(cmpEle[cmpI])}`;
    }

    const tipText = `${formatElevation(ele[i])}  ${grade >= 0 ? '+' : ''}${grade.toFixed(1)}%  ${formatDistance(dist[i])}${cmpStr}${surfStr}${roadStr}${trafficStr}${noiseStr}${speedStr}`;
    const flip = cx > width * 0.6;
    setHoverState({ cx, tipText, flip });
    onHover({ lon: coords[i][0], lat: coords[i][1] });
  };

  const handlePointerLeave = () => {
    setHoverState(null);
    onHover(null);
  };

  return (
    <div id="elevation-chart" ref={containerRef}>
      <svg
        width={width}
        height={CHART_HEIGHT}
        viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
        role="img"
        aria-label="Elevation along the route"
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onPointerCancel={handlePointerLeave}
      >
        <defs>
          <linearGradient
            id="ec-grade-grad"
            gradientUnits="userSpaceOnUse"
            x1={CHART_PAD.left}
            y1={0}
            x2={CHART_PAD.left + plotW}
            y2={0}
          >
            {dist.map((d, i) => {
              const pct = Math.max(0, Math.min(100, (d / total) * 100));
              return (
                <stop
                  key={i}
                  offset={`${pct.toFixed(2)}%`}
                  stopColor={gradeColor(gradeAt(dist, ele, i))}
                />
              );
            })}
          </linearGradient>
        </defs>

        <path d={areaD} className="ec-area" />
        <path d={lineD} className="ec-line" stroke="url(#ec-grade-grad)" />

        {hasCmp && <path d={cmpLineD} className="ec-line-compare" />}

        {hasCmp && (
          <text
            x={width - CHART_PAD.right}
            y={CHART_PAD.top + 9}
            className="ec-label"
            textAnchor="end"
          >
            <tspan fill="#3b82f6">― Router</tspan> <tspan fill="#d946ef">╌ GPX</tspan>
          </text>
        )}

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
        <text x={CHART_PAD.left} y={CHART_HEIGHT - 3} className="ec-label" textAnchor="start">
          {formatDistance(0)}
        </text>
        <text
          x={hasCmp ? width - CHART_PAD.right - 90 : width - CHART_PAD.right}
          y={CHART_HEIGHT - 3}
          className="ec-label"
          textAnchor="end"
        >
          {formatDistance(total)}
        </text>

        {/* Hover cursor and tip */}
        {hoverState && (
          <>
            <line
              className="ec-cursor"
              x1={hoverState.cx}
              x2={hoverState.cx}
              y1={CHART_PAD.top}
              y2={CHART_PAD.top + plotH}
            />
            <text
              className="ec-tip"
              x={hoverState.flip ? hoverState.cx - 6 : hoverState.cx + 6}
              y={CHART_PAD.top + 9}
              textAnchor={hoverState.flip ? 'end' : 'start'}
            >
              {hoverState.tipText}
            </text>
          </>
        )}
      </svg>
    </div>
  );
};
