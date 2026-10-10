import { hydrateIslands } from 'kay/client'

const registry = {
  'tests/fixtures/slots/panel.kay': () => import('./panel.kay'),
  'tests/fixtures/slots/counter.kay': () => import('./counter.kay'),
  'tests/fixtures/slots/label.kay': () => import('./label.kay'),
  'tests/fixtures/slots/picker.kay': () => import('./picker.kay'),
  'tests/fixtures/slots/list.kay': () => import('./list.kay'),
  'tests/fixtures/slots/toolbar.kay': () => import('./toolbar.kay'),
  'tests/fixtures/slots/rows.kay': () => import('./rows.kay'),
  'tests/fixtures/slots/dot.kay': () => import('./dot.kay'),
  'tests/fixtures/slots/plot.kay': () => import('./plot.kay'),
}

export const ready = hydrateIslands(registry)
