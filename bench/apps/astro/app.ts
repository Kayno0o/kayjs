import type { BenchApp } from '../../apps'
import { join } from 'node:path'
import { ensureBuilt } from '../../shared/build'

const DIST = join(import.meta.dir, 'dist')
const SERVER = join(DIST, 'server', 'entry.mjs')

// Astro's handler renders pages only; its built scripts are served from the client build, as its Node adapter does.
export async function createApp(): Promise<BenchApp> {
  await ensureBuilt(import.meta.dir, SERVER, [join('node_modules', 'astro', 'bin', 'astro.mjs'), 'build'])

  const { handle } = await import(SERVER) as BenchApp

  return {
    handle: async (request: Request) => {
      const { pathname } = new URL(request.url)

      if (pathname.startsWith('/_astro/'))
        return new Response(Bun.file(join(DIST, 'client', pathname)), { headers: { 'content-type': 'text/javascript; charset=utf-8' } })

      return handle(request)
    },
  }
}
