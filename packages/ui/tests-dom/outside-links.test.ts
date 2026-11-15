import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import OutsideLinks from '../tests/fixture/src/components/outside-links.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

test('an explicit newTab={false} keeps a link to another site in this tab, where the default opens it in a new one', async () => {
  mounted = await mountComponent(OutsideLinks, {})
  await settle()

  const links = [...mounted.root.querySelectorAll('[data-part="item"] a')].map(link => [link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('data-new-tab')])

  expect(links).toEqual([['https://example.com/docs', '_blank', ''], ['https://example.com/here', null, null]])
})
