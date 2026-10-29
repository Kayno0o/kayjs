import type { LoadTab } from '../../src/runtime/dev-tool'

// The tabs' modules by the URL the dev tool fetches them at, which a test loads from the source instead.
const MODULES: Record<string, () => ReturnType<LoadTab>> = {
  '/_kay/dev/tab/head.js': async () => import('../../src/runtime/dev-tab-head'),
  '/_kay/dev/tab/reading.js': async () => import('../../src/runtime/dev-tab-reading'),
  '/_kay/dev/tab/env.js': async () => import('../../src/runtime/dev-tab-env'),
  '/_kay/dev/tab/not-found.js': async () => import('../../src/runtime/dev-tab-not-found'),
  '/_kay/dev/tab/network.js': async () => import('../../src/runtime/dev-tab-network'),
  '/_kay/dev/tab/i18n.js': async () => import('../../src/runtime/dev-tab-i18n'),
  '/_kay/dev/tab/images.js': async () => import('../../src/runtime/dev-tab-images'),
  '/_kay/dev/tab/performance.js': async () => import('../../src/runtime/dev-tab-performance'),
}

export const loadTab: LoadTab = async (url) => {
  const load = MODULES[url]

  if (load === undefined)
    throw new Error(`no test module for ${url}`)

  return load()
}
