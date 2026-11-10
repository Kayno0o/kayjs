import type { Mounted } from 'kay/test'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import AvatarGroups from '../tests/fixture/src/components/avatar-groups.kay'
import { click } from './dom'

let mounted: Mounted | undefined
const opens: boolean[] = []
const loads: number[] = []
const errors: unknown[] = []

// The failing source logs its rejection, as every source does.
beforeEach(() => {
  spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  opens.length = 0
  loads.length = 0
  errors.length = 0
})

async function groups() {
  mounted = await mountComponent(AvatarGroups, { onOpenChange: (open: boolean) => opens.push(open), onLoad: (count: number) => loads.push(count), onError: (error: unknown) => errors.push(error) })
  await settle()

  return mounted.root
}

const names = (root: Element, id: string) => [...root.querySelectorAll(`#${id} > [data-part=root]`)].map(one => one.getAttribute('aria-label'))

describe('AvatarGroup', () => {
  test('draws max avatars and a +N chip for the rest, none when they fit or fill max exactly', async () => {
    const root = await groups()

    expect(names(root, 'popover')).toEqual(['Ada, online', 'Linus, busy'])
    expect(root.querySelector('#popover')!.getAttribute('aria-label')).toBe('Team')
    expect(root.querySelector('#popover [data-part=more]')!.getAttribute('aria-label')).toBe('3 more')
    expect(root.querySelector('#popover [data-part=count]')!.textContent).toBe('+3')
    expect(root.querySelector('#under [data-part=more]')).toBeNull()
    expect(root.querySelector('#exact [data-part=more]')).toBeNull()
    expect(root.querySelectorAll('#exact > [data-part=root]')).toHaveLength(5)
  })

  test('the chip is a link to moreHref, named by moreLabel', async () => {
    const root = await groups()
    const chip = root.querySelector<HTMLAnchorElement>('#linked [data-part=more]')!

    expect([chip.tagName, chip.getAttribute('href'), chip.getAttribute('aria-label')]).toEqual(['A', '/team', 'See 2 more'])
    expect(root.querySelector('#linked [popovertarget]')).toBeNull()
  })

  test('the chip opens a popover listing the rest, reporting each change, a person with an href being a link', async () => {
    const root = await groups()
    const chip = root.querySelector<HTMLButtonElement>('#popover button[data-part=more]')!
    const panel = root.querySelector<HTMLElement>(`#${chip.getAttribute('popovertarget')}`)!

    expect(chip.getAttribute('aria-expanded')).toBe('false')

    panel.showPopover()
    await settle()

    expect(opens).toEqual([true])
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    expect([...panel.querySelectorAll('[data-part=name]')].map(one => one.textContent)).toEqual(['Grace', 'Margaret', 'Dennis'])
    expect([...panel.querySelectorAll('[data-part=row]')].map(row => [row.tagName, row.getAttribute('href')])).toEqual([['A', '/grace'], ['DIV', null], ['DIV', null]])

    panel.hidePopover()
    await settle()

    expect(opens).toEqual([true, false])
  })

  test('replaces the avatar and the list with the avatar and rest blocks', async () => {
    const root = await groups()

    expect([...root.querySelectorAll('#custom b.mine')].map(one => one.textContent)).toEqual(['Ada'])
    expect(root.querySelector('#custom p.rest')!.textContent).toBe('4 others')
  })

  test('asks a function source in the browser and reports the answer, or the failure, with a retry', async () => {
    const root = await groups()

    expect(loads).toEqual([5])
    expect(names(root, 'remote')).toHaveLength(2)
    expect(root.querySelector('#remote')!.getAttribute('aria-busy')).toBeNull()
    expect([root.querySelector('#pending')!.getAttribute('aria-busy'), root.querySelector('#pending [role=status]')!.textContent]).toEqual(['true', 'Un instant'])
    expect(errors).toHaveLength(1)
    expect(root.querySelector('#failing [role=status]')!.textContent).toBe('Could not load the people')

    click(root.querySelector('#heal'))
    click(root.querySelector<HTMLElement>('#failing [data-part=retry]'))
    await settle()

    expect(names(root, 'failing')).toHaveLength(2)
    expect(root.querySelector('#failing [role=status]')).toBeNull()
  })
})

describe('Avatar status and xl size', () => {
  test('names the status in the avatar name, an own label and statusLabel included, and draws a dot', async () => {
    const root = await groups()
    const label = (id: string) => root.querySelector(`#${id}`)!.getAttribute('aria-label')

    expect(label('dot-online')).toBe('Ada, online')
    expect(root.querySelector('#dot-online')!.getAttribute('role')).toBe('img')
    expect(label('dot-offline')).toBe('Ada L., offline')
    expect(label('dot-custom')).toBe('Ada, at lunch')
    expect(root.querySelector('#dot-custom')!.tagName).toBe('A')
    expect(root.querySelector('#dot-online [data-part=status]')!.getAttribute('data-presence')).toBe('online')
    expect(root.querySelector('#dot-online [data-part=status]')!.getAttribute('aria-hidden')).toBe('true')
  })

  test('takes the xl size', async () => {
    const root = await groups()

    expect(root.querySelector('#xl')!.getAttribute('data-size')).toBe('xl')
    expect(root.querySelector('#xl')!.className).toContain('size-20')
  })
})
