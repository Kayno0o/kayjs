import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { cms } from '../../../src/extension'

const ROOT = join(import.meta.dir, '..')

// The fixture's kay.config.ts calls cms() as it loads, after this one, so the settings are given again once it has.
test('serves its routes under a moved apiPath, the sign-in link, the page link loader and the preview image routes included', async () => {
  const site = await testSite({ root: ROOT, extensions: [cms({})], apiPath: '/v1' })

  cms({})

  try {
    const back = await site.fetch('/v1/cms/sign-in?redirect=%2Fadmin')

    expect(back.status).toBe(302)
    expect(new URL(back.headers.get('location')!, 'http://site.test').pathname).toBe('/admin/sign-in')
    expect((await site.fetch('/api/cms/sign-in?redirect=%2Fadmin')).status).toBe(404)

    const page = await (await site.fetch('/about')).text()

    expect(page).toContain('<meta name="kay-api" content="/v1">')
    expect(page).toContain('/cms/editor/module.js')
  }
  finally {
    await site.close()
  }
})
