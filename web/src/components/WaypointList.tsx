import React, { useState, useEffect, useRef } from 'react';
import {
  AVOID_RADIUS_PRESETS,
  waypointKind,
  waypointLabel,
  type AvoidArea,
  type LatLon,
} from '../types.ts';
import { reverseGeocode, isOnlineMode } from '../geocoding.ts';
import { Icon } from './common/Icon.tsx';

interface WaypointListProps {
  waypoints: LatLon[];
  avoidAreas?: AvoidArea[];
  editingWaypointIndex?: number | null;
  onClearEditingWaypoint?: () => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRemove: (index: number) => void;
  onRename: (index: number, name: string, expectedCoords?: { lat: number; lon: number }) => void;
  onRemoveAvoidArea?: (index: number) => void;
  onUpdateAvoidAreaRadius?: (index: number, radius: number) => void;
  onClearAvoidAreas?: () => void;
  onFlyTo?: (lon: number, lat: number) => void;
}

export const WaypointList: React.FC<WaypointListProps> = ({
  waypoints,
  avoidAreas = [],
  editingWaypointIndex,
  onClearEditingWaypoint,
  onReorder,
  onRemove,
  onRename,
  onRemoveAvoidArea,
  onUpdateAvoidAreaRadius,
  onClearAvoidAreas,
  onFlyTo,
}) => {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ index: number; isAbove: boolean } | null>(null);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [pendingCoords, setPendingCoords] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const geocodedKeysRef = useRef<Set<string>>(new Set());
  const attemptedCoordsRef = useRef<Set<string>>(new Set());

  const wpCoordKey = (w: LatLon) => `${w.lat.toFixed(5)},${w.lon.toFixed(5)}`;

  // Sync external rename trigger (e.g., from map marker context menu)
  useEffect(() => {
    if (editingWaypointIndex !== undefined && editingWaypointIndex !== null && waypoints[editingWaypointIndex]) {
      setEditingIdx(editingWaypointIndex);
      setEditValue(waypoints[editingWaypointIndex].name || '');
      onClearEditingWaypoint?.();
    }
  }, [editingWaypointIndex, waypoints, onClearEditingWaypoint]);

  useEffect(() => {
    if (editingIdx !== null && editingIdx >= waypoints.length) {
      setEditingIdx(null);
    }
  }, [editingIdx, waypoints.length]);

  useEffect(() => {
    if (editingIdx !== null && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingIdx]);

  // Reverse geocoding unresolved waypoints (auto-geocode only when <= 10 waypoints)
  const AUTO_GEOCODE_MAX_POINTS = 10;

  const geocodeWaypointAt = (i: number) => {
    if (!isOnlineMode()) return;
    const w = waypoints[i];
    if (!w || w.name) return;
    const cKey = wpCoordKey(w);
    const key = `${i}:${cKey}`;
    geocodedKeysRef.current.add(key);
    attemptedCoordsRef.current.add(cKey);
    setPendingCoords((prev) => {
      if (prev.has(cKey)) return prev;
      const next = new Set(prev);
      next.add(cKey);
      return next;
    });
    const reqLat = w.lat;
    const reqLon = w.lon;
    reverseGeocode(reqLat, reqLon)
      .then((name) => {
        if (!name) return;
        onRename(i, name, { lat: reqLat, lon: reqLon });
      })
      .finally(() => {
        setPendingCoords((prev) => {
          if (!prev.has(cKey)) return prev;
          const next = new Set(prev);
          next.delete(cKey);
          return next;
        });
      });
  };

  const geocodeAllWaypoints = () => {
    if (!isOnlineMode()) return;
    waypoints.forEach((w, i) => {
      if (!w.name) {
        geocodeWaypointAt(i);
      }
    });
  };

  useEffect(() => {
    if (!isOnlineMode()) return;
    if (waypoints.length === 0) {
      geocodedKeysRef.current.clear();
      attemptedCoordsRef.current.clear();
      setPendingCoords((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    if (waypoints.length > AUTO_GEOCODE_MAX_POINTS) {
      return;
    }
    waypoints.forEach((w, i) => {
      const key = `${i}:${wpCoordKey(w)}`;
      if (!w.name && !geocodedKeysRef.current.has(key)) {
        geocodeWaypointAt(i);
      }
    });
  }, [waypoints, onRename]);

  const startEditing = (i: number) => {
    setEditingIdx(i);
    setEditValue(waypoints[i]?.name || '');
  };

  const commitEdit = (i: number) => {
    if (editingIdx === i) {
      const w = waypoints[i];
      if (w) {
        geocodedKeysRef.current.add(`${i}:${w.lat.toFixed(5)},${w.lon.toFixed(5)}`);
      }
      onRename(i, editValue);
      setEditingIdx(null);
    }
  };

  const cancelEdit = () => {
    setEditingIdx(null);
  };

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, i: number) => {
    if ((e.target as HTMLElement).closest('button, input')) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(i));
    requestAnimationFrame(() => {
      setDraggedIndex(i);
    });
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>, i: number) => {
    if (draggedIndex === null || draggedIndex === i) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const isAbove = e.clientY < rect.top + rect.height / 2;
    setDropTarget({ index: i, isAbove });
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDropTarget(null);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (draggedIndex === null || draggedIndex === i) {
      setDraggedIndex(null);
      setDropTarget(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const isAbove = e.clientY < rect.top + rect.height / 2;
    let targetIndex = isAbove ? i : i + 1;
    if (draggedIndex < targetIndex) targetIndex--;
    if (draggedIndex !== targetIndex) {
      onReorder(draggedIndex, targetIndex);
    }
    setDraggedIndex(null);
    setDropTarget(null);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDropTarget(null);
  };

  // Pointer / Touch handle drag
  const handleTouchPointerDown = (e: React.PointerEvent<HTMLSpanElement>, i: number) => {
    if (e.pointerType === 'mouse') return;
    const startY = e.clientY;
    let isDragging = false;
    let currentTargetIdx: number | null = null;
    let isAbove = false;

    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      setDraggedIndex(null);
      setDropTarget(null);
    };

    const onPointerMove = (ev: PointerEvent) => {
      if (!isDragging && Math.abs(ev.clientY - startY) > 6) {
        isDragging = true;
        setDraggedIndex(i);
      }
      if (!isDragging) return;
      ev.preventDefault();

      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const targetRow = el?.closest('.wp-row') as HTMLElement | null;
      if (targetRow && targetRow.dataset.index !== undefined) {
        const idx = Number(targetRow.dataset.index);
        const rect = targetRow.getBoundingClientRect();
        isAbove = ev.clientY < rect.top + rect.height / 2;
        currentTargetIdx = idx;
        setDropTarget({ index: idx, isAbove });
      } else {
        currentTargetIdx = null;
        setDropTarget(null);
      }
    };

    const onPointerCancel = () => {
      cleanup();
    };

    const onPointerUp = () => {
      cleanup();

      if (currentTargetIdx !== null && currentTargetIdx !== i) {
        let targetIndex = isAbove ? currentTargetIdx : currentTargetIdx + 1;
        if (i < targetIndex) targetIndex--;
        if (i !== targetIndex) {
          onReorder(i, targetIndex);
        }
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  };

  const n = waypoints.length;

  if (n === 0 && avoidAreas.length === 0) {
    return <div id="waypoint-list" ref={listRef} />;
  }

  const isGeocodingAny = pendingCoords.size > 0;
  const hasUnattemptedWaypoints =
    isOnlineMode() &&
    waypoints.some((w) => !w.name && !attemptedCoordsRef.current.has(wpCoordKey(w)));

  return (
    <div className="waypoints-container">
      {n > AUTO_GEOCODE_MAX_POINTS && hasUnattemptedWaypoints && !isGeocodingAny && (
        <div className="avoid-list-header" style={{ marginBottom: '4px' }}>
          <span className="avoid-list-title">Auto-geocoding paused ({n} points)</span>
          <button
            id="btn-geocode-all"
            type="button"
            className="avoid-clear-btn"
            style={{ color: 'var(--accent)' }}
            title="Lookup street names for all unnamed waypoints"
            onClick={geocodeAllWaypoints}
          >
            Geocode all
          </button>
        </div>
      )}
      {n > 0 && (
        <div id="waypoint-list" ref={listRef}>
          {waypoints.map((w, i) => {
            const cKey = wpCoordKey(w);
            const isRowGeocoding = !w.name && pendingCoords.has(cKey);
            const coordStr = `${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}`;
            const displayName = w.name || coordStr;
            const titleAttr = w.name
              ? `${w.name} (${coordStr}) · Click to rename`
              : `${coordStr} · Click to rename`;

            let rowClass = 'wp-row';
            if (draggedIndex === i) rowClass += ' dragging';
            if (dropTarget?.index === i) {
              rowClass += dropTarget.isAbove ? ' drop-above' : ' drop-below';
            }

            return (
              <div
                key={i}
                className={rowClass}
                data-index={i}
                draggable={editingIdx !== i}
                onDragStart={(e) => handleDragStart(e, i)}
                onDragOver={(e) => handleDragOver(e, i)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, i)}
                onDragEnd={handleDragEnd}
              >
                <span
                  className="wp-drag-handle"
                  title="Drag to reorder"
                  aria-label="Drag to reorder"
                  onPointerDown={(e) => handleTouchPointerDown(e, i)}
                >
                  <Icon name="grip" size={12} />
                </span>
                <button
                  type="button"
                  className={`wp-badge ${waypointKind(i, n)}`}
                  title="Center map on this point"
                  onClick={() => onFlyTo?.(w.lon, w.lat)}
                >
                  {waypointLabel(i, n)}
                </button>
                <div className="wp-info">
                  {editingIdx === i ? (
                    <input
                      ref={editInputRef}
                      type="text"
                      className="wp-rename-input"
                      value={editValue}
                      placeholder={coordStr}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => commitEdit(i)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitEdit(i);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelEdit();
                        }
                      }}
                    />
                  ) : isRowGeocoding ? (
                    <span
                      className="wp-loading-placeholder"
                      title={`Looking up address for ${coordStr}`}
                      aria-label="Looking up address"
                    >
                      <span className="wp-loading-shimmer" />
                    </span>
                  ) : (
                    <span
                      className="wp-name"
                      title={titleAttr}
                      onClick={(e) => {
                        e.stopPropagation();
                        startEditing(i);
                      }}
                    >
                      {displayName}
                    </span>
                  )}
                </div>
                <div className="wp-actions">
                  {!w.name && !isRowGeocoding && isOnlineMode() && n > AUTO_GEOCODE_MAX_POINTS && (
                    <button
                      type="button"
                      className="wp-btn"
                      title="Geocode this waypoint"
                      aria-label="Geocode this waypoint"
                      onClick={() => geocodeWaypointAt(i)}
                    >
                      <Icon name="search" size={12} />
                    </button>
                  )}
                  {n > 2 && (
                    <>
                      <button
                        type="button"
                        className="wp-btn"
                        title="Move point up"
                        aria-label="Move point up"
                        disabled={i === 0}
                        onClick={() => onReorder(i, i - 1)}
                      >
                        <Icon name="arrow-up" size={12} />
                      </button>
                      <button
                        type="button"
                        className="wp-btn"
                        title="Move point down"
                        aria-label="Move point down"
                        disabled={i === n - 1}
                        onClick={() => onReorder(i, i + 1)}
                      >
                        <Icon name="arrow-down" size={12} />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="wp-btn wp-btn-remove"
                    title="Remove point"
                    aria-label="Remove point"
                    onClick={() => onRemove(i)}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {avoidAreas.length > 0 && (
        <div className="avoid-list-section">
          {avoidAreas.length > 1 && onClearAvoidAreas && (
            <div className="avoid-list-header">
              <span className="avoid-list-title">Avoid Areas ({avoidAreas.length})</span>
              <button
                type="button"
                className="avoid-clear-btn"
                onClick={onClearAvoidAreas}
              >
                Clear all
              </button>
            </div>
          )}
          <div className="avoid-chips" aria-label="Avoid areas">
            {avoidAreas.map((area, idx) => {
              const r = Math.round(area.radius);
              const nextRadius =
                AVOID_RADIUS_PRESETS[
                  (AVOID_RADIUS_PRESETS.indexOf(r) + 1) % AVOID_RADIUS_PRESETS.length
                ] || AVOID_RADIUS_PRESETS[0];
              return (
                <div key={idx} className="avoid-chip">
                  <button
                    type="button"
                    className="avoid-chip-locate"
                    title={`Center on avoid area (${area.lat.toFixed(4)}, ${area.lon.toFixed(4)})`}
                    onClick={() => onFlyTo?.(area.lon, area.lat)}
                  >
                    <Icon name="ban" size={11} />
                    <span>Avoid #{idx + 1}</span>
                  </button>
                  {onUpdateAvoidAreaRadius && (
                    <button
                      type="button"
                      className="avoid-chip-radius"
                      title="Click to cycle avoid radius"
                      onClick={() => onUpdateAvoidAreaRadius(idx, nextRadius)}
                    >
                      {r} m
                    </button>
                  )}
                  {onRemoveAvoidArea && (
                    <button
                      type="button"
                      className="avoid-chip-remove"
                      title="Remove avoid area"
                      aria-label={`Remove avoid area ${idx + 1}`}
                      onClick={() => onRemoveAvoidArea(idx)}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

