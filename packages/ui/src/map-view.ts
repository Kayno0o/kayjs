// A place on the map as [latitude, longitude] degrees, the order Leaflet and most APIs write it in; a plain array, so a route built in code needs no cast, and one of another length is skipped.
export type MapPoint = readonly number[]

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
export function drawnPoints(lines: readonly (readonly MapPoint[])[], markers: readonly MapMarker[]): MapPoint[] {
  return [...lines.flat(), ...markers.map(marker => marker.at)]
}

// Whether a coordinate is one a map can place: finite, and within the globe.
export function validPoint(point: MapPoint): boolean {
  const [latitude, longitude] = point

  return point.length === 2 && latitude !== undefined && longitude !== undefined && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
}

// The part of Leaflet the map uses, declared here so an app installs `leaflet` alone and needs no @types/leaflet.
export interface LeafletLayer {
  addTo: (target: LeafletGroup | LeafletView) => this
  remove: () => this
}

export interface LeafletPath extends LeafletLayer {
  bindTooltip: (content: HTMLElement) => this
  bindPopup: (content: HTMLElement) => this
}

export interface LeafletGroup extends LeafletLayer {
  clearLayers: () => this
}

export interface LeafletView {
  addControl: (control: unknown) => this
  fitBounds: (bounds: unknown, options: { padding: [number, number], maxZoom: number, animate: boolean }) => this
  setView: (center: MapPoint, zoom: number, options: { animate: boolean }) => this
  invalidateSize: (options: { animate: boolean }) => this
  getSize: () => { x: number, y: number }
  remove: () => this
}

export interface LeafletApi {
  map: (element: HTMLElement, options: { zoomSnap: number, attributionControl: boolean, zoomAnimation: boolean, fadeAnimation: boolean, markerZoomAnimation: boolean }) => LeafletView
  control: { attribution: (options: { prefix: false }) => unknown }
  tileLayer: (url: string, options: { maxZoom: number, attribution: string }) => LeafletLayer
  layerGroup: () => LeafletGroup
  polyline: (path: MapPoint[], options: { weight: number, className: string, interactive?: boolean }) => LeafletPath
  circleMarker: (at: MapPoint, options: { radius: number, weight: number, className: string, interactive: boolean }) => LeafletPath
  latLngBounds: (points: MapPoint[]) => unknown
  DomUtil: { create: (tag: string) => HTMLElement }
}
