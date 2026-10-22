import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { cms } from '../../../src/extension'
import { passwordGuard } from '../../../src/password'
import { cmsSignInAs } from '../../../src/test'

const ROOT = join(import.meta.dir, '..')

const options = { guard: passwordGuard({ editor: 'pw-editor', admin: 'pw-admin' }), roles: { editor: [], admin: ['delete', 'redirects'] } } as const

// The app's own dev module sits where the cms's does, so the guard places a request by the next anchor (preview), under any apiPath and base.
for (const { name, site: siteOptions, root } of [
  { name: 'under the default mount', site: {}, root: '' },
  { name: 'under an apiPath', site: { apiPath: '/v1' }, root: '' },
  { name: 'under a base', site: { base: '/site' }, root: '/site' },
  { name: 'under a base and an apiPath', site: { base: '/site', apiPath: '/v1' }, root: '/site' },
]) {
  test(`with the dev module replaced, a role lacking an action is refused on its route and one holding it let through, ${name}`, async () => {
    const site = await testSite({ root: ROOT, extensions: [cms(options)], ...siteOptions })

    // The fixture's kay.config.ts calls cms() as it loads, after this one, so the settings are given again once it has.
    cms(options)

    try {
      const mount = `${root}/_kay/cms`

      await cmsSignInAs(site, 'editor')
      expect([(await site.fetch(mount)).status, (await site.fetch(`${mount}/`)).status]).toEqual([404, 404])
      expect((await site.fetch(`${mount}/redirects/paths?q=a`)).status).toBe(403)
      expect((await site.fetch(`${mount}/files/unused/delete`, { method: 'POST' })).status).toBe(403)

      await cmsSignInAs(site, 'admin')
      expect((await site.fetch(`${mount}/redirects/paths?q=a`)).status).toBe(200)
      expect((await site.fetch(`${mount}/files/unused/delete`, { method: 'POST' })).status).not.toBe(403)
    }
    finally {
      await site.close()
    }
  })
}
