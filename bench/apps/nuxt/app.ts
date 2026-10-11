import type { BenchApp } from '../../apps'
import { join } from 'node:path'
import { ensureBuilt } from '../../shared/build'

const SERVER = join(import.meta.dir, '.output', 'server', 'index.mjs')

export async function createApp(): Promise<BenchApp> {
  await ensureBuilt(import.meta.dir, SERVER, [join('node_modules', 'nuxt', 'bin', 'nuxt.mjs'), 'build'])

  return await import(SERVER) as BenchApp
}
