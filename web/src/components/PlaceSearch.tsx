import React, { useState, useEffect, useRef } from 'react';
import { isOnlineMode, searchPlaces, cachePlaceName, type GeocodePlace } from '../geocoding.ts';
import type { LatLon } from '../types.ts';

interface PlaceSearchProps {
  isOfflineMode: boolean;
  getMapCenter?: () => { lat: number; lon: number };
  onFlyTo?: (lon: number, lat: number) => void;
  onSelectPlace: (point: LatLon, action?: 'start' | 'end' | 'via') => void;
}

export const PlaceSearch: React.FC<PlaceSearchProps> = ({
  isOfflineMode,
  getMapCenter,
  onFlyTo,
  onSelectPlace,
}) => {
  const [query, setQuery] = useState<string>('');
  const [results, setResults] = useState<GeocodePlace[]>([]);
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
    if (!query.trim()) {
      setResults([]);
      setStatusMessage('');
      setIsOpen(false);
      return;
    }

    if (!online) {
      setResults([]);
      setStatusMessage('Place search requires online mode');
      setIsOpen(true);
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      const q = query.trim();
      const center = getMapCenter?.();
      const places = await searchPlaces(q, center);
      if (inputRef.current?.value.trim() !== q) return;

      if (places.length === 0) {
        setStatusMessage('No places found');
        setResults([]);
      } else {
        setStatusMessage('');
        setResults(places);
      }
      setIsOpen(true);
    }, 250);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, online, getMapCenter]);

  // Click outside and escape key handling
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
    setStatusMessage('');
    setIsOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setIsOpen(false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results.length > 0) {
        handleSelect(results[0]);
      }
    }
  };

  return (
    <div className="search-box" ref={containerRef}>
      <div className="search-input-wrap">
        <svg
          className="search-icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input
          ref={inputRef}
          type="text"
          id="input-place-search"
          placeholder={online ? 'Search place or address...' : 'Place search unavailable offline'}
          disabled={!online}
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {query.length > 0 && (
          <button
            id="btn-clear-search"
            className="search-clear-btn"
            title="Clear search"
            aria-label="Clear search"
            onClick={handleClear}
          >
            ✕
          </button>
        )}
      </div>

      {isOpen && (
        <div id="search-results-list" className="search-results">
          {statusMessage ? (
            <div className="search-status-item">{statusMessage}</div>
          ) : (
            results.map((p, idx) => (
              <div
                key={idx}
                className="search-item"
                onClick={() => handleSelect(p)}
              >
                <div className="search-item-info">
                  <span className="search-item-title">{p.title}</span>
                  {p.subtitle && <span className="search-item-subtitle">{p.subtitle}</span>}
                </div>
                <div className="search-item-actions">
                  <button
                    className="search-act-btn"
                    title="Set as start"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelect(p, 'start');
                    }}
                  >
                    Start
                  </button>
                  <button
                    className="search-act-btn"
                    title="Set as destination"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelect(p, 'end');
                    }}
                  >
                    End
                  </button>
                  <button
                    className="search-act-btn"
                    title="Add as via point"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelect(p, 'via');
                    }}
                  >
                    Via
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
