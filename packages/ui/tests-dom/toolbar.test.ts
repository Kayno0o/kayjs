import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import Toolbars from '../tests/fixture/src/components/toolbars.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function toolbars() {
  mounted = await mountComponent(Toolbars, {})

  return mounted.root
}

describe('Toolbar', () => {
  test('names its buttons as a toolbar, framed only when floating', async () => {
    const root = await toolbars()
    const plain = root.querySelector('#plain')!
    const floating = root.querySelector('#floating')!

    expect(plain.getAttribute('role')).toBe('toolbar')
    expect(plain.getAttribute('aria-label')).toBe('Moons')
    expect(plain.hasAttribute('data-floating')).toBe(false)
    expect(floating.hasAttribute('data-floating')).toBe(true)
    expect(floating.getAttribute('style')).toBe('top: 10px; left: 20px')
  })

  test('writes its caption after the buttons for the eyes only, and a lone button is a group', async () => {
    const root = await toolbars()
    const caption = root.querySelector('#floating > [data-part=caption]')!

    expect(caption.textContent).toBe('Moons: Phobos')
    expect(caption.getAttribute('aria-hidden')).toBe('true')
    expect(caption.previousElementSibling?.textContent).toBe('Down')
    expect(root.querySelector('#plain > [data-part=caption]')).toBeNull()
    expect(root.querySelector('#group')?.getAttribute('role')).toBe('group')
  })
})

describe('PageSection head', () => {
  test('sticks on one line only when asked, with the subtitle under the title', async () => {
    const root = await toolbars()
    const sticky = root.querySelector('#sticky')!
    const head = sticky.querySelector('[data-part=head]')!

    expect(head.hasAttribute('data-sticky')).toBe(true)
    expect(head.querySelector('hgroup > h3[data-part=title]')?.textContent).toBe('Phobos')
    expect(head.querySelector('hgroup > p[data-part=subtitle]')?.textContent).toBe('Moons')
    expect(head.lastElementChild?.textContent).toBe('Save')

    const plain = root.querySelector('#plain-section')!

    expect(plain.querySelector('[data-part=head]')?.hasAttribute('data-sticky')).toBe(false)
    expect(plain.querySelector('hgroup')).toBeNull()
    expect(plain.querySelector('[data-part=head] > h3')?.textContent).toBe('Deimos')
  })
})
