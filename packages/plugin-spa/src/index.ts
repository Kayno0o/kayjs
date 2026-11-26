// @kayjs/spa — opt-in in-place navigation: `spa()` swaps whole pages and keeps persistent islands (~700 B gzip), `regions()` swaps one <Region> of a page. 0 B when uninstalled.

import type { KayPlugin } from '@kayjs/kay/config'
import { resolve } from 'node:path'
import { definePlugin } from '@kayjs/kay/config'
import { checkRegionTargets } from './check'

export function spa(): KayPlugin {
  return definePlugin({
    name: '@kayjs/spa',
    clientEntry: resolve(import.meta.dir, 'client.ts'),
  })
}

export function regions(): KayPlugin {
  return definePlugin({
    name: '@kayjs/spa/regions',
    clientEntry: resolve(import.meta.dir, 'regions.ts'),
    check: checkRegionTargets,
  })
}
