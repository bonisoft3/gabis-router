import React, { useState, useEffect, useRef } from 'react';
import type { LatLon } from '../types.ts';
import { reverseGeocode, isOnlineMode } from '../geocoding.ts';
import { Icon } from './common/Icon.tsx';

interface WaypointListProps {
  waypoints: LatLon[];
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRemove: (index: number) => void;
  onRename: (index: number, name: string) => void;
}

function waypointKind(i: number, n: number): 'start' | 'end' | 'via' {
  if (i === 0) return 'start';
  return i === n - 1 ? 'end' : 'via';
}

function waypointLabel(i: number, n: number): string {
  const kind = waypointKind(i, n);
  return kind === 'start' ? 'A' : kind === 'end' ? 'B' : String(i);
}

export const WaypointList: React.FC<WaypointListProps> = ({
  waypoints,
  onReorder,
  onRemove,
  onRename,
}) => {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ index: number; isAbove: boolean } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Reverse geocoding unresolved waypoints
  useEffect(() => {
    if (!isOnlineMode()) return;
    waypoints.forEach((w, i) => {
      if (!w.name) {
        reverseGeocode(w.lat, w.lon).then((name) => {
          if (name && waypoints[i] && Math.abs(waypoints[i].lat - w.lat) < 0.00001 && Math.abs(waypoints[i].lon - w.lon) < 0.00001) {
            onRename(i, name);
          }
        });
      }
    });
  }, [waypoints, onRename]);

  if (waypoints.length === 0) return null;

  const n = waypoints.length;

  const handleRowClickRename = (i: number) => {
    const current = waypoints[i]?.name || '';
    const nextName = window.prompt('Rename point:', current);
    if (nextName !== null) {
      onRename(i, nextName);
    }
  };

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, i: number) => {
    setDraggedIndex(i);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(i));
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>, i: number) => {
    if (draggedIndex === null || draggedIndex === i) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const isAbove = e.clientY < rect.top + rect.height / 2;
    setDropTarget({ index: i, isAbove });
  };

  const handleDragLeave = () => {
    setDropTarget(null);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>, i: number) => {
    e.preventDefault();
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

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      setDraggedIndex(null);
      setDropTarget(null);

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
  };

  return (
    <div id="waypoint-list" ref={listRef} style={{ display: 'block' }}>
      {waypoints.map((w, i) => {
        const coordStr = `${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}`;
        const displayName = w.name || coordStr;
        const titleAttr = w.name
          ? `${w.name} (${coordStr}) - Click to rename`
          : `${coordStr} - Click to rename`;

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
            draggable
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
            <span className={`wp-badge ${waypointKind(i, n)}`}>{waypointLabel(i, n)}</span>
            <div className="wp-info">
              <span
                className="wp-name"
                title={titleAttr}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRowClickRename(i);
                }}
              >
                {displayName}
              </span>
              {w.name && <span className="wp-coords">{coordStr}</span>}
            </div>
            <button
              type="button"
              className="wp-btn"
              aria-label="Move point up"
              disabled={i === 0}
              onClick={() => onReorder(i, i - 1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="wp-btn"
              aria-label="Move point down"
              disabled={i === n - 1}
              onClick={() => onReorder(i, i + 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="wp-btn"
              aria-label="Remove point"
              onClick={() => onRemove(i)}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
};
