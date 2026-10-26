// A place on the map as [latitude, longitude] degrees, the order Leaflet and most APIs write it in.
export type MapPoint = [number, number]

export interface MapMarker {
  at: MapPoint
  // Shown beside the marker on hover as text, and read by screen readers in the map's list.
  label?: string | undefined
  // Opens on a click, as plain text.
  popup?: string | undefined
}

export const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'

// Every point the map draws, which it fits into view.
export function drawnPoints(lines: MapPoint[][], markers: MapMarker[]): MapPoint[] {
  return [...lines.flat(), ...markers.map(marker => marker.at)]
}

// Whether a coordinate is one a map can place: finite, and within the globe.
export function validPoint(point: MapPoint): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180
}
