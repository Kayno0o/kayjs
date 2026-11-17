import { hydrateIslands } from 'kay/client'

const registry = {
  'tests/fixtures/lazy-ui/page.kay': () => import('./page.kay'),
  'tests/fixtures/lazy-ui/open.kay': () => import('./open.kay'),
  'tests/fixtures/lazy-ui/nested.kay': () => import('./nested.kay'),
  'tests/fixtures/lazy-ui/each.kay': () => import('./each.kay'),
  'tests/fixtures/lazy-ui/wrapped.kay': () => import('./wrapped.kay'),
  'tests/fixtures/lazy-ui/wrappedclosed.kay': () => import('./wrappedclosed.kay'),
  'tests/fixtures/lazy-ui/guarded.kay': () => import('./guarded.kay'),
  'tests/fixtures/lazy-ui/breaks.kay': () => import('./breaks.kay'),
}

export const hydrateAgain = async () => hydrateIslands(registry)
