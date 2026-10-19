import type { ServedRoute } from '../src/server/guards'
import type { PageResponder } from '../src/server/page-routes'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { RELOAD_HEADER } from '../src/runtime/swap'
import { withPageHeaders } from '../src/server/page-headers'
import { scratchDir } from './scratch'

describe('withPageHeaders', () => {
  it('reads a route\'s settings again after its modules failed to load once', async () => {
    const file = join(await scratchDir('page-headers'), 'late.ts')
    const route = { file, layouts: [] as string[] } as unknown as ServedRoute
    const respond: PageResponder = async () => new Response('page')
    const wrapped = withPageHeaders(respond, {}, undefined)
    const call = async () => wrapped(route, {}, {} as never, new URL('http://localhost/'))

    await expect(call()).rejects.toThrow()
    await Bun.write(file, 'export const page = { reload: true }\n')

    expect((await call()).headers.get(RELOAD_HEADER)).toBe('1')
  })
})
