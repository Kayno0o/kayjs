// @kayjs/spa — opt-in in-place SPA navigation & persistent islands plugin (~700 B gzip, 0 B when uninstalled).

import type { KayPlugin } from 'kay/server'
import { resolve } from 'node:path'

export function spa(): KayPlugin {
  return {
    name: '@kayjs/spa',
    clientEntry: resolve(import.meta.dir, 'client.ts'),
  }
}
