import React, { useRef } from 'react';
import type { ComparedRoute } from '../utils/gpx.ts';
import { formatDistance, formatElevation, formatDuration, type Units } from '../format.ts';
import { InfoButton } from './TooltipPopover.tsx';

interface CompareCardProps {
  comparedRoute: ComparedRoute | null;
  currentRoute: GeoJSON.FeatureCollection | null;
  units: Units;
  onLoadGpxFile: (file: File) => void;
  onClearCompare: () => void;
  onMatchCompare: () => void;
}

export const CompareCard: React.FC<CompareCardProps> = ({
  comparedRoute,
  currentRoute,
  units: _units,
  onLoadGpxFile,
  onClearCompare,
  onMatchCompare,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onLoadGpxFile(file);
    }
    e.target.value = '';
  };

  // Extract router route metrics if available
  let routerDist: number | null = null;
  let routerAscent: number | null = null;
  let routerTime: number | null = null;

  if (currentRoute && currentRoute.features.length > 0) {
    const props = (currentRoute.features[0].properties || {}) as Record<string, any>;
    routerDist = Number(props['track-length'] || 0);
    routerAscent = Number(props['filtered ascend'] || 0);
    routerTime = Number(props['total-time'] || 0);
  }

  // Calculate Diffs
  let diffDistStr = '-';
  let diffDistClass = '';
  let diffAscentStr = '-';
  let diffAscentClass = '';
  let diffTimeStr = '-';
  let diffTimeClass = '';

  if (comparedRoute && routerDist !== null && routerAscent !== null && routerTime !== null) {
    const dD = routerDist - comparedRoute.distanceM;
    const signD = dD > 0 ? '+' : dD < 0 ? '-' : '';
    diffDistStr = `${signD}${formatDistance(Math.abs(dD))}`;
    diffDistClass = dD <= 0 ? 'compare-diff-neg' : 'compare-diff-pos';

    const dA = routerAscent - comparedRoute.ascentM;
    const signA = dA > 0 ? '+' : dA < 0 ? '-' : '';
    diffAscentStr = `${signA}${formatElevation(Math.abs(dA))}`;
    diffAscentClass = dA <= 0 ? 'compare-diff-neg' : 'compare-diff-pos';

    if (comparedRoute.durationS !== undefined) {
      const dT = routerTime - comparedRoute.durationS;
      const signT = dT > 0 ? '+' : dT < 0 ? '-' : '';
      diffTimeStr = `${signT}${formatDuration(Math.abs(dT))}`;
      diffTimeClass = dT <= 0 ? 'compare-diff-neg' : 'compare-diff-pos';
    }
  }

  return (
    <>
      <div style={{ marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <input
          ref={fileInputRef}
          type="file"
          id="input-compare-gpx"
          accept=".gpx"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        <button
          id="btn-compare-gpx"
          className="btn btn-outline"
          style={{ flex: 1 }}
          onClick={() => fileInputRef.current?.click()}
        >
          Compare GPX
        </button>
        <InfoButton
          tooltip="Upload a recorded or planned GPX track to compare distance, climbing, and route choice against the current router output."
          ariaLabel="About Compare GPX"
        />
      </div>

      {comparedRoute && (
        <div id="compare-card" className="compare-card">
          <div className="compare-header">
            <span className="compare-title">Compare GPX</span>
            <button
              id="btn-clear-compare"
              className="compare-close-btn"
              title="Remove compared route"
              aria-label="Remove compared route"
              onClick={onClearCompare}
            >
              ✕
            </button>
          </div>
          <div id="compare-name" className="compare-name">
            {comparedRoute.name}
          </div>
          <table className="compare-table">
            <thead>
              <tr>
                <th></th>
                <th>Router</th>
                <th>GPX</th>
                <th>Diff</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Distance</td>
                <td id="cmp-router-dist">
                  {routerDist !== null ? formatDistance(routerDist) : '-'}
                </td>
                <td id="cmp-gpx-dist">{formatDistance(comparedRoute.distanceM)}</td>
                <td id="cmp-diff-dist" className={diffDistClass}>
                  {diffDistStr}
                </td>
              </tr>
              <tr>
                <td>Ascent</td>
                <td id="cmp-router-ascent">
                  {routerAscent !== null ? formatElevation(routerAscent) : '-'}
                </td>
                <td id="cmp-gpx-ascent">{formatElevation(comparedRoute.ascentM)}</td>
                <td id="cmp-diff-ascent" className={diffAscentClass}>
                  {diffAscentStr}
                </td>
              </tr>
              {comparedRoute.durationS !== undefined && (
                <tr id="cmp-row-time">
                  <td>Time</td>
                  <td id="cmp-router-time">
                    {routerTime !== null ? formatDuration(routerTime) : '-'}
                  </td>
                  <td id="cmp-gpx-time">{formatDuration(comparedRoute.durationS)}</td>
                  <td id="cmp-diff-time" className={diffTimeClass}>
                    {diffTimeStr}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <button
            id="btn-match-compare"
            className="btn btn-outline btn-sm"
            style={{ width: '100%', marginTop: '6px' }}
            onClick={onMatchCompare}
          >
            Match start &amp; end to GPX
          </button>
        </div>
      )}
    </>
  );
};
