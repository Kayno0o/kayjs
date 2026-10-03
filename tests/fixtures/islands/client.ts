import { hydrateIslands } from 'kay/client'

export const ready = hydrateIslands({
  'tests/fixtures/islands/counter.kay': () => import('./counter.kay'),
  'tests/fixtures/islands/greeting.kay': () => import('./greeting.kay'),
})
