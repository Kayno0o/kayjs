import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { deprecatedCollectionLinks } from '../src/check/deprecated-collection-links'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

const HEAD = 'import { collection } from \'kay/content\'\n\n'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('collection-links-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-collection-links', () => {
  it('drops the url function and a feed item path written as the route', async () => {
    const config = `${HEAD}export const posts = collection('content/posts', { schema, route: '/blog/:slug', url: ({ slug }) => \`/blog/\${slug}\`, feed: { path: '/rss.xml', title: 'Blog', item: post => ({ title: post.data.title, date: post.data.date, path: \`/blog/\${post.slug}\` }) } })\n`
    const root = await project({ 'src/content.config.ts': config })

    try {
      const found = await deprecatedCollectionLinks(root, {})

      expect(found).toHaveLength(2)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/content.config.ts')).text()).toBe(`${HEAD}export const posts = collection('content/posts', { schema, route: '/blog/:slug', feed: { path: '/rss.xml', title: 'Blog', item: post => ({ title: post.data.title, date: post.data.date }) } })\n`)
      expect(await deprecatedCollectionLinks(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a path that differs from the route with no fix, and a block body too', async () => {
    const config = `${HEAD}export const docs = collection('content/docs', { schema, route: '/docs/*slug', feed: { path: '/rss.xml', item: (doc) => {\n  return { title: 'x', date: new Date(), path: \`/guides/\${doc.slug}\` }\n} } })\n`
    const root = await project({ 'src/content.config.ts': config })

    try {
      const found = await deprecatedCollectionLinks(root, {})

      expect(found).toHaveLength(1)
      expect(found[0]!.fixes).toBeUndefined()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves a collection without a route, another collection function and an allowed line alone', async () => {
    const config = `${HEAD}export const a = collection('content/a', { schema, url: ({ slug }) => \`/a/\${slug}\`, feed: { path: '/rss.xml', title: 'A', item: e => ({ title: 'x', date: new Date(), path: \`/a/\${e.slug}\` }) } })\n`
    const other = 'import { collection } from \'./mine\'\n\nexport const b = collection(\'x\', { route: \'/b/:slug\', url: () => \'/b\' })\n'
    const allowed = `${HEAD}// kay-allow deprecated-collection-links\nexport const c = collection('content/c', { schema, route: '/c/:slug', url: () => '/c' })\n`
    const root = await project({ 'src/a.ts': config, 'src/b.ts': other, 'src/c.ts': allowed })

    try {
      expect(await deprecatedCollectionLinks(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
