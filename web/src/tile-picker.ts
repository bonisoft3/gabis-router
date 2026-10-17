// Map control button to switch basemap styles (Standard vector, CyclOSM, OpenCycleMap).

import { getBasemap, onBasemapChange, setBasemap, type Basemap } from './basemap.ts';

export class TilePickerControl implements maplibregl.IControl {
  private container?: HTMLElement;
  private button?: HTMLButtonElement;
  private menu?: HTMLElement;
  private unsubBasemap?: () => void;
  private isOpen = false;
  private isOffline = false;

  onAdd(): HTMLElement {
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group tile-picker-ctrl';

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'maplibregl-ctrl-tile-picker';
    this.button.title = 'Map style';
    this.button.setAttribute('aria-label', 'Select map style');
    this.button.setAttribute('aria-haspopup', 'true');
    this.button.setAttribute('aria-expanded', 'false');

    this.button.innerHTML = '<span class="maplibregl-ctrl-icon" aria-hidden="true"></span>';

    this.menu = document.createElement('div');
    this.menu.className = 'tile-picker-menu';
    this.menu.hidden = true;
    this.menu.setAttribute('role', 'menu');

    this.renderMenu();

    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    document.addEventListener('click', this.onDocClick);
    document.addEventListener('keydown', this.onKeyDown);

    this.unsubBasemap = onBasemapChange(() => {
      this.updateActiveState();
    });

    this.container.appendChild(this.button);
    this.container.appendChild(this.menu);
    return this.container;
  }

  onRemove(): void {
    document.removeEventListener('click', this.onDocClick);
    document.removeEventListener('keydown', this.onKeyDown);
    this.unsubBasemap?.();
    this.unsubBasemap = undefined;
    this.button = undefined;
    this.menu = undefined;
    this.container?.remove();
  }

  setOffline(offline: boolean) {
    this.isOffline = offline;
    this.renderMenu();
  }

  private onDocClick = (e: MouseEvent) => {
    if (!this.isOpen) return;
    if (this.container && !this.container.contains(e.target as Node)) {
      this.close();
    }
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.isOpen) {
      this.close();
    }
  };

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    if (!this.menu || !this.button) return;
    this.isOpen = true;
    this.menu.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.button.classList.add('active');
  }

  close() {
    if (!this.menu || !this.button) return;
    this.isOpen = false;
    this.menu.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    this.button.classList.remove('active');
  }

  private renderMenu() {
    if (!this.menu) return;
    const current = getBasemap();
    const options: { id: Basemap; label: string; desc: string }[] = [
      { id: 'standard', label: 'Standard', desc: 'Vector map' },
      { id: 'cyclosm', label: 'CyclOSM', desc: 'Bicycle infrastructure' },
      { id: 'opencyclemap', label: 'OpenCycleMap', desc: 'Thunderforest topo' },
    ];

    this.menu.innerHTML = `
      <div class="tile-picker-header">Map Style</div>
      ${options
        .map((opt) => {
          const isActive = current === opt.id;
          const isDisabled = this.isOffline && opt.id !== 'standard';
          return `
            <button
              type="button"
              class="tile-picker-opt ${isActive ? 'active' : ''}"
              data-basemap="${opt.id}"
              role="menuitemradio"
              aria-checked="${isActive}"
              ${isDisabled ? 'disabled title="Unavailable offline"' : ''}
            >
              <div class="tile-opt-info">
                <span class="tile-opt-label">${opt.label}</span>
                <span class="tile-opt-desc">${opt.desc}</span>
              </div>
              <svg class="tile-opt-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="${isActive ? '' : 'display:none;'}">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </button>
          `;
        })
        .join('')}
    `;

    this.menu.querySelectorAll<HTMLButtonElement>('.tile-picker-opt').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const basemap = btn.dataset.basemap as Basemap;
        if (basemap) {
          setBasemap(basemap);
          this.close();
        }
      });
    });
  }

  private updateActiveState() {
    if (!this.menu) return;
    const current = getBasemap();
    this.menu.querySelectorAll<HTMLButtonElement>('.tile-picker-opt').forEach((btn) => {
      const isActive = btn.dataset.basemap === current;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-checked', String(isActive));
      const check = btn.querySelector<SVGElement>('.tile-opt-check');
      if (check) check.style.display = isActive ? '' : 'none';
    });
  }
}

export const tilePickerControl = new TilePickerControl();
