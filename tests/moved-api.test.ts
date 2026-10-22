import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { scanApi } from '../src/server/api-modules'
import { withMovedApi } from '../src/server/rewrite'
import { scratchDir } from './scratch'

const MOVED = [{ former: '/cms', prefix: '/_kay/cms' }]
const url = (path: string) => new URL(path, 'http://site.test')
const request = new Request('http://site.test/')

it('serves an extension tree whose prefix starts with /_kay/ there, whatever apiPath is', async () => {
  const dir = await scratchDir('moved-api-')

  await mkdir(join(dir, 'lib'), { recursive: true })
  await writeFile(join(dir, 'lib/dev.ts'), 'export default {}\n')

  const modules = await scanApi(join(dir, 'app'), [{ dir: join(dir, 'lib'), prefix: '/_kay/cms' }, { dir: join(dir, 'lib'), prefix: '/auth' }], '/v1')

  expect(modules.map(module => module.mount)).toEqual(['/_kay/cms/dev', '/v1/auth/dev'])
})

it('rewrites a path under the former prefix to the new one, query kept, the base kept', () => {
  const rewrite = withMovedApi(undefined, MOVED, '/api', '')!

  expect(rewrite(url('/api/cms/entries/posts/a?locale=fr'), request)).toBe('/_kay/cms/entries/posts/a?locale=fr')
  expect(rewrite(url('/api/cms'), request)).toBe('/_kay/cms')
  expect(rewrite(url('/api/cmsx/entries'), request)).toBeUndefined()
  expect(rewrite(url('/_kay/cms/entries'), request)).toBeUndefined()
  expect(withMovedApi(undefined, MOVED, '/v1', '/site')!(url('/site/v1/cms/dev'), request)).toBe('/site/_kay/cms/dev')
  expect(withMovedApi(undefined, MOVED, '/v1', '/site')!(url('/site/api/cms/dev'), request)).toBeUndefined()
})

it('leaves the app\'s own rewrite in charge of every other path, and is none when nothing moved', () => {
  const own = (path: URL) => path.pathname === '/old' ? '/new' : undefined
  const rewrite = withMovedApi(own, MOVED, '/api', '')!

  expect(rewrite(url('/old'), request)).toBe('/new')
  expect(rewrite(url('/api/cms/dev'), request)).toBe('/_kay/cms/dev')
  expect(withMovedApi(own, [], '/api', '')).toBe(own)
  expect(withMovedApi(undefined, [], '/api', '')).toBeUndefined()
})

it('leaves a path an API module of the app serves to it, and aliases the rest below the former prefix', () => {
  const rewrite = withMovedApi(undefined, MOVED, '/api', '', ['/api/cms', '/api/cmsx'])!
  const below = withMovedApi(undefined, MOVED, '/api', '', ['/api/cms/hook'])!

  expect(rewrite(url('/api/cms'), request)).toBeUndefined()
  expect(rewrite(url('/api/cms/entries/posts/a'), request)).toBeUndefined()
  expect(below(url('/api/cms/hook'), request)).toBeUndefined()
  expect(below(url('/api/cms/hook/x'), request)).toBeUndefined()
  expect(below(url('/api/cms/entries'), request)).toBe('/_kay/cms/entries')
  expect(below(url('/api/cms'), request)).toBe('/_kay/cms')
})
