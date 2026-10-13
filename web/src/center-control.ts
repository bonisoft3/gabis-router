// Map control button to center the route in the map viewport.

import type maplibregl from 'maplibre-gl';

export class CenterRouteControl implements maplibregl.IControl {
  private container?: HTMLElement;
  private button?: HTMLButtonElement;
  private onCenterCallback?: () => void;

  setOnCenter(cb: () => void) {
    this.onCenterCallback = cb;
  }

  setEnabled(enabled: boolean) {
    if (this.button) {
      this.button.disabled = !enabled;
      this.button.style.opacity = enabled ? '1' : '0.4';
      this.button.style.cursor = enabled ? 'pointer' : 'default';
    }
  }

  onAdd(): HTMLElement {
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group center-route-ctrl';

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'maplibregl-ctrl-center-route';
    this.button.title = 'Center route';
    this.button.setAttribute('aria-label', 'Center route in map');
    this.button.innerHTML = '<span class="maplibregl-ctrl-icon" aria-hidden="true"></span>';

    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onCenterCallback?.();
    });

    this.container.appendChild(this.button);
    return this.container;
  }

  onRemove(): void {
    this.button = undefined;
    this.container?.remove();
  }
}

export const centerRouteControl = new CenterRouteControl();
