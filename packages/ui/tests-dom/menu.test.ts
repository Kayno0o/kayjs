import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

test('a Menu entry is destructive by its tone or the deprecated danger flag, the tone winning', async () => {
  mounted = await mountComponent('src/components/menus.kay')

  const items = [...mounted.root.querySelectorAll('#by-tone [data-part=item]')].map(item => [item.textContent, item.hasAttribute('data-danger')])

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

test('a Menu entry with an icon draws it as the icon part, sized and shrunk, and one without writes none', async () => {
  mounted = await mountComponent('src/components/menus.kay')

  const [added, bare] = [...mounted.root.querySelectorAll('#icons [data-part=item]')]

  expect([...added!.querySelectorAll('[data-part=icon]')].map(icon => [...icon.classList])).toEqual([expect.arrayContaining(['size-4', 'shrink-0'])])
  expect(bare!.querySelector('[data-part=icon]')).toBeNull()
})
