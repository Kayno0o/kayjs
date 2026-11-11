import { afterEach, expect, mock, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { library } from './dom'

// A stand-in for Leaflet: every call answers a chainable stand-in, and the module counts its loads.
const ANSWERS: Record<string, () => unknown> = { getSize: () => ({ x: 0, y: 0 }), getCenter: () => ({ lat: 0, lng: 0 }), getZoom: () => 2 }

function stand(): unknown {
  return new Proxy(stand, { get: (_, name) => ANSWERS[String(name)] ?? stand })
}

let loads = 0

await mock.module('leaflet', () => {
  loads++

  return { map: stand, control: { attribution: stand }, tileLayer: stand, layerGroup: stand, polyline: stand, circleMarker: stand, latLngBounds: stand, DomUtil: { create: () => document.createElement('div') } }
})

const real = globalThis.IntersectionObserver
const callbacks: ((entries: { isIntersecting: boolean }[]) => void)[] = []
const nothing = () => undefined
let mounted: Awaited<ReturnType<typeof mountComponent>> | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  globalThis.IntersectionObserver = real
  callbacks.length = 0
})

test('loads Leaflet once the map comes into view, not while it is far below the fold', async () => {
  globalThis.IntersectionObserver = class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      callbacks.push(callback)
    }

    observe = nothing
    disconnect = nothing
  } as unknown as typeof IntersectionObserver

  mounted = await mountComponent(await library('map-view'), { label: 'Route', lines: [[[48.85, 2.35], [48.86, 2.36]]] })
  await settle()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(loads).toBe(0)

  callbacks.at(-1)!([{ isIntersecting: true }])
  await settle()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(loads).toBe(1)
})

test('never loads Leaflet for a map unmounted before it came into view', async () => {
  globalThis.IntersectionObserver = class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      callbacks.push(callback)
    }

    observe = nothing
    disconnect = nothing
  } as unknown as typeof IntersectionObserver

  const before = loads

  mounted = await mountComponent(await library('map-view'), { label: 'Route' })
  mounted.unmount()
  mounted = undefined
  callbacks.at(-1)!([{ isIntersecting: true }])
  await settle()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(loads).toBe(before)
})
