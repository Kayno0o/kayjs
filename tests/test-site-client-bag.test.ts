import { expect, it } from 'bun:test'
import { testSite } from '../src/test'
import { fixtureCopy } from './scratch'

it('options for one key of a bag keep the config\'s other keys of it', async () => {
  const root = await fixtureCopy('static')
  const site = await testSite({ root, styles: true, client: { navigation: false } })
  const page = await site.visit('/')

  // The config of the fixture sets client.inlineStyles: false, so the page still links its stylesheet.
  expect(page.find('link[rel~=stylesheet]').length).toBeGreaterThan(0)
  await site.close()
}, 60_000)
