// @kayjs/spa — opt-in in-place SPA navigation & persistent islands plugin (~700 B gzip, 0 B when uninstalled).

import type { KayPlugin } from '@kayjs/kay/config'
import { resolve } from 'node:path'
import { definePlugin } from '@kayjs/kay/config'

export function spa(): KayPlugin {
  return definePlugin({
    name: '@kayjs/spa',
    clientEntry: resolve(import.meta.dir, 'client.ts'),
  })
}
