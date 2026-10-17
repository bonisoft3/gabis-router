import React, { useState, useEffect, useRef } from 'react';
import { isOnlineMode, searchPlaces, cachePlaceName, type GeocodePlace } from '../geocoding.ts';
import type { LatLon } from '../types.ts';
import { parseCoordinateInput } from '../utils/geo.ts';
import { Icon } from './common/Icon.tsx';

interface PlaceSearchProps {
  isOfflineMode: boolean;
  getMapCenter?: () => { lat: number; lon: number };
  onFlyTo?: (lon: number, lat: number) => void;
  onSelectPlace: (point: LatLon, action?: 'start' | 'end' | 'via') => void;
  onStartFromMyLocation?: () => void;
}

export const PlaceSearch: React.FC<PlaceSearchProps> = ({
  isOfflineMode,
  getMapCenter,
  onFlyTo,
  onSelectPlace,
  onStartFromMyLocation,
}) => {
  const [query, setQuery] = useState<string>('');
  const [results, setResults] = useState<GeocodePlace[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [online, setOnline] = useState<boolean>(() => isOnlineMode() && !isOfflineMode);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleNetChange = () => setOnline(isOnlineMode() && !isOfflineMode);
    window.addEventListener('online', handleNetChange);
    window.addEventListener('offline', handleNetChange);
    window.addEventListener('offlinemodechange', handleNetChange);
    return () => {
      window.removeEventListener('online', handleNetChange);
      window.removeEventListener('offline', handleNetChange);
      window.removeEventListener('offlinemodechange', handleNetChange);
    };
  }, [isOfflineMode]);

  useEffect(() => {
    setOnline(isOnlineMode() && !isOfflineMode);
  }, [isOfflineMode]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setActiveIndex(0);
      setStatusMessage('');
      setIsOpen(false);
      return;
    }

    // Direct coordinate entry works both online and offline
    const coordPt = parseCoordinateInput(q);
    if (coordPt) {
      setResults([
        {
          lat: coordPt.lat,
          lon: coordPt.lon,
          title: `${coordPt.lat.toFixed(5)}, ${coordPt.lon.toFixed(5)}`,
          subtitle: 'Coordinates',
          name: `${coordPt.lat.toFixed(5)}, ${coordPt.lon.toFixed(5)}`,
        },
      ]);
      setActiveIndex(0);
      setStatusMessage('');
      setIsOpen(true);
      return;
    }

    if (!online) {
      setResults([]);
      setStatusMessage('Place search requires online mode. You can still paste lat, lon coordinates.');
      setIsOpen(true);
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      const center = getMapCenter?.();
      const places = await searchPlaces(q, center);
      if (inputRef.current?.value.trim() !== q) return;

      if (places.length === 0) {
        setStatusMessage('No places found');
        setResults([]);
      } else {
        setStatusMessage('');
        setResults(places);
        setActiveIndex(0);
      }
      setIsOpen(true);
    }, 220);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, online, getMapCenter]);

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const handleClear = () => {
    setQuery('');
    setResults([]);
    setActiveIndex(0);
    setStatusMessage('');
    setIsOpen(false);
    inputRef.current?.focus();
  };

  const handleSelect = (place: GeocodePlace, action?: 'start' | 'end' | 'via') => {
    cachePlaceName(place.lat, place.lon, place.name);
    onFlyTo?.(place.lon, place.lat);
    onSelectPlace({ lat: place.lat, lon: place.lon, name: place.name }, action);
    setQuery('');
    setResults([]);
    setActiveIndex(0);
    setStatusMessage('');
    setIsOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setIsOpen(false);
    } else if (e.key === 'ArrowDown') {
      if (results.length > 0) {
        e.preventDefault();
        setIsOpen(true);
        setActiveIndex((prev) => (prev + 1) % results.length);
      }
    } else if (e.key === 'ArrowUp') {
      if (results.length > 0) {
        e.preventDefault();
        setIsOpen(true);
        setActiveIndex((prev) => (prev - 1 + results.length) % results.length);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results.length > 0) {
        handleSelect(results[activeIndex] || results[0]);
      }
    }
  };

  return (
    <div className="search-box" ref={containerRef}>
      <div className="search-row">
        <div className="search-input-wrap">
          <Icon name="search" size={14} className="search-icon" />
          <input
            ref={inputRef}
            type="text"
            id="input-place-search"
            placeholder={online ? 'Search place, postcode, or lat, lon...' : 'Enter lat, lon coordinates...'}
            autoComplete="off"
            value={query}
            onFocus={() => {
              if (results.length > 0 || statusMessage) setIsOpen(true);
            }}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {query.length > 0 && (
            <button
              id="btn-clear-search"
              type="button"
              className="search-clear-btn"
              title="Clear search"
              aria-label="Clear search"
              onClick={handleClear}
            >
              <Icon name="close" size={13} />
            </button>
          )}
        </div>
        {onStartFromMyLocation && (
          <button
            id="btn-my-location"
            type="button"
            className="btn btn-outline btn-icon search-loc-btn"
            title="Start from my location"
            aria-label="Start from my location"
            onClick={onStartFromMyLocation}
          >
            <Icon name="locate" size={15} />
          </button>
        )}
      </div>

      {isOpen && (
        <div id="search-results-list" className="search-results" role="listbox">
          {statusMessage ? (
            <div className="search-status-item">{statusMessage}</div>
          ) : (
            results.map((p, idx) => (
              <div
                key={idx}
                role="option"
                aria-selected={idx === activeIndex}
                className={`search-item ${idx === activeIndex ? 'active' : ''}`}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => handleSelect(p)}
              >
                <div className="search-item-info">
                  <span className="search-item-title">{p.title}</span>
                  {p.subtitle && <span className="search-item-subtitle">{p.subtitle}</span>}
                </div>
                <div className="search-item-actions">
                  <button
                    type="button"
                    className="search-act-btn"
                    title="Set as start (A)"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelect(p, 'start');
                    }}
                  >
                    Start
                  </button>
                  <button
                    type="button"
                    className="search-act-btn"
                    title="Insert as via point"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelect(p, 'via');
                    }}
                  >
                    Via
                  </button>
                  <button
                    type="button"
                    className="search-act-btn"
                    title="Set as destination (B)"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelect(p, 'end');
                    }}
                  >
                    End
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

