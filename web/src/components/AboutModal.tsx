import React, { useEffect } from 'react';
import { Icon } from './common/Icon.tsx';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AboutModal: React.FC<AboutModalProps> = ({ isOpen, onClose }) => {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      id="about-modal"
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <div className="about-header">
          <div className="about-header-text">
            <h2 id="about-title">
              <span className="header-logo" aria-hidden="true">
                <Icon name="bike" size={17} />
              </span>
              <span>GBRouter</span>
            </h2>
            <p>Bike routing on your terms.</p>
          </div>
          <button
            id="btn-close-about"
            type="button"
            className="about-close-btn"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="about-body">
          <div>
            <h3>Why GBRouter exists</h3>
            <p>
              GBRouter is built by cycling nerds, for cycling nerds. It is made for people who care about how a route
              feels. Most route planners treat you like someone who just wants to get from A to B. They hide the map data
              and make decisions for you.
            </p>
            <p style={{ marginTop: '8px' }}>
              <a href="https://brouter.de" target="_blank" rel="noopener">
                BRouter
              </a>{' '}
              is a great alternative. It is a configurable routing engine that scores every road based on custom cycling
              profiles. But the classic web interface at{' '}
              <a href="https://brouter.de/brouter-web/" target="_blank" rel="noopener">
                brouter-web
              </a>{' '}
              is quite limited, and tweaking routing behaviour means writing a custom{' '}
              <a href="https://brouter.de/brouter/costfunctions.html" target="_blank" rel="noopener">
                profile DSL
              </a>
              .
            </p>
            <p style={{ marginTop: '8px' }}>
              GBRouter brings the BRouter engine directly into your browser using WebAssembly. There is no separate
              server to run. It also puts the nerdy details at the centre: surfaces, road types, traffic, speed limits,
              and noise estimates. It is designed for cyclists who want to tweak their route until it feels right.
            </p>
            <p style={{ marginTop: '8px', fontStyle: 'italic', color: 'var(--muted)' }}>
              Visual profile editing without writing DSL code is coming soon.
            </p>
          </div>

          <div>
            <h3>Offline and private</h3>
            <p>
              The router runs entirely in your browser using WebAssembly with no accounts, no tracking, and no server
              queries. Download the routing data and map files once, and the whole thing works in airplane mode or out in
              the hills with zero phone reception.
            </p>
            <p style={{ marginTop: '6px', fontWeight: 500 }}>GBRouter is open source and free forever.</p>
          </div>

          <div>
            <h3>Open source credits</h3>
            <p style={{ marginBottom: '6px' }}>
              GBRouter builds on great work by the open source mapping and cycling community:
            </p>
            <ul>
              <li>
                <a href="https://www.openstreetmap.org" target="_blank" rel="noopener">
                  OpenStreetMap
                </a>{' '}
                for map data, road classifications, and surface tags
              </li>
              <li>
                <a href="https://brouter.de" target="_blank" rel="noopener">
                  BRouter
                </a>{' '}
                for the original routing engine and profile algorithms by Arndt Brenschede
              </li>
              <li>
                <a href="https://maplibre.org" target="_blank" rel="noopener">
                  MapLibre GL
                </a>{' '}
                for map rendering
              </li>
              <li>
                <a href="https://protomaps.com" target="_blank" rel="noopener">
                  Protomaps
                </a>{' '}
                and{' '}
                <a href="https://github.com/protomaps/PMTiles" target="_blank" rel="noopener">
                  PMTiles
                </a>{' '}
                for offline vector map tiles
              </li>
              <li>
                <a href="https://photon.komoot.io" target="_blank" rel="noopener">
                  Photon
                </a>{' '}
                by Komoot for search and geocoding
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};
