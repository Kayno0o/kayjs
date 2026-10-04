import { hydrateIslands } from 'kay/client'

const registry = {
  'tests/fixtures/islands/counter.kay': () => import('./counter.kay'),
  'tests/fixtures/islands/greeting.kay': () => import('./greeting.kay'),
  'tests/fixtures/islands/slow.kay': () => import('./slow.kay'),
  'tests/fixtures/islands/plain.kay': () => import('./plain.kay'),
  'tests/fixtures/islands/rich.kay': () => import('./rich.kay'),
  'tests/fixtures/islands/picker.kay': () => import('./picker.kay'),
  'tests/fixtures/islands/joined.kay': () => import('./joined.kay'),
  'tests/fixtures/islands/tally.kay': () => import('./tally.kay'),
  'tests/fixtures/islands/typed.kay': () => import('./typed.kay'),
}

export const ready = hydrateIslands(registry)
export const hydrateAgain = async () => hydrateIslands(registry)
