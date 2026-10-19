import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

test('a Menu entry is destructive by its tone or the deprecated danger flag, the tone winning', async () => {
  mounted = await mountComponent('src/components/menus.kay')

  const items = [...mounted.root.querySelectorAll('#by-tone .kui-menu-item')].map(item => [item.textContent, item.hasAttribute('data-danger')])

  expect(items).toEqual([['Tone', true], ['Old', true], ['Wins', false], ['Plain', false]])
})

test('a Menu trigger takes a tone, the danger variant being the danger tone', async () => {
  mounted = await mountComponent('src/components/menus.kay')

  const trigger = (id: string) => {
    const button = mounted!.root.querySelector(`[popovertarget="${id}"]`)!

    return [button.getAttribute('data-variant'), button.getAttribute('data-tone')]
  }

  expect([trigger('by-tone'), trigger('plain')]).toEqual([['ghost', 'danger'], ['ghost', 'neutral']])
})
