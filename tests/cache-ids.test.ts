import { describe, expect, it } from 'bun:test'
import { cacheIds } from '../src/build/cache-ids'
import { liveId } from '../src/build/live-ids'

const ROOT = '/app'
const FILE = '/app/src/posts.ts'
const id = (name: string) => JSON.stringify(liveId(FILE, ROOT, name))

describe('cacheIds', () => {
  it('gives each top-level cache and tag the id of its module and name', () => {
    const source = 'import { cache, cacheTag } from \'kay/cache\'\n\nexport const group = cacheTag()\nexport const posts = cache(() => 1, { ttl: 60, tags: [group] })\n'

    expect(cacheIds(source, FILE, ROOT)).toBe(`import { cache, cacheTag } from 'kay/cache'\n\nexport const group = cacheTag(${id('group')})\nexport const posts = cache(() => 1, { ttl: 60, tags: [group] }, ${id('posts')})\n`)
  })

  it('follows an alias, a trailing comma and a comment closing the call', () => {
    const source = 'import { cache as keep } from \'kay/cache\'\n\nconst posts = keep(\n  () => 1,\n  { ttl: 60 }, // end\n)\n'

    expect(cacheIds(source, FILE, ROOT)).toBe(`import { cache as keep } from 'kay/cache'\n\nconst posts = keep(\n  () => 1,\n  { ttl: 60 }, ${id('posts')} // end\n)\n`)
  })

  it('leaves a call that is not a top-level constant, or from another module, as it is', () => {
    expect(cacheIds('import { cache } from \'kay/cache\'\n\nfunction make() {\n  return cache(() => 1, { ttl: 60 })\n}\n', FILE, ROOT)).toContain('{ ttl: 60 })\n')
    expect(cacheIds('import { cache } from \'./mine\'\n\nconst posts = cache(() => 1, { ttl: 60 })\n', FILE, ROOT)).not.toContain(id('posts'))
    expect(cacheIds('import { cache } from \'kay/cache\'\n\nconst posts = cache(() => 1, { ttl: 60 }, \'mine\')\n', FILE, ROOT)).not.toContain(id('posts'))
  })

  it('names the same id wherever the project sits', () => {
    const source = 'import { cache } from \'kay/cache\'\n\nconst posts = cache(() => 1, { ttl: 60 })\n'

    expect(cacheIds(source, '/srv/app/src/posts.ts', '/srv/app')).toBe(cacheIds(source, FILE, ROOT))
  })
})
