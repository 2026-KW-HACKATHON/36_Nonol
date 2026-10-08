import { projectRoute } from './route-geo.js';

export class RouteAR {
  constructor(elements) {
    this.elements = elements;
  }

  update(position, target, options = {}) {
    const model = projectRoute(position, target, options);
    const { container, marker, distance, direction, status } = this.elements;
    container.hidden = false;
    container.dataset.state = model.state;
    container.dataset.mode = model.mode;
    marker.hidden = !model.markerVisible;
    marker.dataset.edge = model.edge || 'center';
    marker.style.left = `${model.markerPercent}%`;
    marker.style.transform = `translateX(-50%) rotate(${model.onScreen ? model.turn : 0}deg)`;
    marker.textContent = model.edge === 'left' ? '←' : model.edge === 'right' ? '→' : '↑';
    distance.textContent = model.distance === null ? '거리 확인 중'
      : model.distance < 1000 ? `${Math.round(model.distance)}m` : `${(model.distance / 1000).toFixed(1)}km`;
    direction.textContent = model.direction;
    status.textContent = model.message;
    return model;
  }

  hide() {
    this.elements.container.hidden = true;
    this.elements.marker.hidden = true;
  }

  stop() {
    this.hide();
  }
}
