import { distanceMeters, validPosition } from './geo.js';

export function courseDistance(config) {
  return validPosition(config?.start) && validPosition(config?.destination)
    ? distanceMeters(config.start, config.destination) : null;
}

export function validWalkingCourse(config) {
  if (config?.mode === 'simulation') return true;
  const distance = courseDistance(config);
  return config?.mode === 'gps' && distance !== null && Number.isFinite(config.radius) && config.radius > 0
    && distance > config.radius * 2;
}
