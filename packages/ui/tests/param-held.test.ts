import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { ui } from '../src/extension'

const options = (html: string, id: string) => html.slice(html.indexOf(`id="${id}"`), html.indexOf('</select>', html.indexOf(`id="${id}"`)))

it('renders the option the request names as selected or checked, with and without a locale prefix', async () => {
  const site = await testSite({ root: `${import.meta.dir}/fixture`, extensions: [ui()], islands: false })

  try {
    for (const path of ['/param-held', '/fr/param-held']) {
      const html = (await site.visit(`${path}?period=30d&range=24h`)).html

      expect(options(html, 'select')).toMatch(/value="30d"[^>]*selected|selected[^>]*value="30d"/)
      expect(options(html, 'select')).not.toMatch(/value="7d"[^>]*selected|selected[^>]*value="7d"/)
      expect(options(html, 'select-bare')).toMatch(/value="24h"[^>]*selected|selected[^>]*value="24h"/)
      expect(html).toMatch(/<input[^>]*value="30d"[^>]*checked|<input[^>]*checked[^>]*value="30d"/)
    }
  }
  finally {
    await site.close()
  }
}, 60_000)

it('renders paramDefault while the param is left out or outside the options', async () => {
  const site = await testSite({ root: `${import.meta.dir}/fixture`, extensions: [ui()], islands: false })

  try {
    for (const query of ['', '?period=1y']) {
      const html = (await site.visit(`/param-held${query}`)).html

      expect(options(html, 'select')).toMatch(/value="7d"[^>]*selected|selected[^>]*value="7d"/)
      expect(html).toMatch(/<input[^>]*value="7d"[^>]*checked|<input[^>]*checked[^>]*value="7d"/)
    }
  }
  finally {
    await site.close()
  }
}, 60_000)
