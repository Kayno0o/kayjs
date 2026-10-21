import { expect, it } from 'bun:test'
import { entrySource } from '../src/content'
import { testSite } from '../src/test'
import { news } from './fixtures/cms/src/content.config'

const FIXTURE = 'tests/fixtures/cms/src'

it('gives loaders and folders back to the project when the last site closes', async () => {
  const site = await testSite({ routes: `${FIXTURE}/routes`, content: `${FIXTURE}/content.config.ts`, islands: false })

  await site.content.seed('news', [{ slug: 'seeded', data: { title: 'Seeded', published: true, tags: [] } }])
  expect((await news.loader?.load({ preview: false }))?.map(entry => entry.slug)).toEqual(['seeded'])

  const copy = await entrySource('articles', 'fresh', { title: 'Copy' }, { locale: 'fr', create: true })

  expect('file' in copy && copy.file.absolute).toContain('.kay/scratch/')

  await site.close()

  expect((await news.loader?.load({ preview: false }))?.map(entry => entry.slug)).not.toContain('seeded')

  const real = await entrySource('articles', 'fresh', { title: 'Real' }, { locale: 'fr', create: true })

  expect('file' in real && real.file.absolute).not.toContain('.kay/scratch/')
})
