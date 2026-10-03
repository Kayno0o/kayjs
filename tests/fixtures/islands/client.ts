import { hydrateIslands } from 'kay/client'

const registry = {
  'tests/fixtures/islands/counter.kay': () => import('./counter.kay'),
  'tests/fixtures/islands/greeting.kay': () => import('./greeting.kay'),
  'tests/fixtures/islands/slow.kay': () => import('./slow.kay'),
  'tests/fixtures/islands/plain.kay': () => import('./plain.kay'),
}

export const ready = hydrateIslands(registry)
export const hydrateAgain = async () => hydrateIslands(registry)
