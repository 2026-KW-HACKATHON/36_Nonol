export function routePoints({ start, destination }) {
  return [
    { lat: (start.lat + destination.lat) / 2, lon: (start.lon + destination.lon) / 2 },
    { ...destination }
  ];
}
