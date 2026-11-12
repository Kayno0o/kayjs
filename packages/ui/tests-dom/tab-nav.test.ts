import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import TabsLater from '../tests/fixture/src/components/tabs-later.kay'
import Tabs from '../tests/fixture/src/components/tabs.kay'

// eslint-disable-next-line ts/unbound-method -- only put back on the prototype they were taken from
const { getBoundingClientRect, scrollIntoView } = HTMLElement.prototype

afterEach(() => {
  Object.assign(HTMLElement.prototype, { getBoundingClientRect, scrollIntoView })
})

test('centres the current tab in a bar too narrow for every tab, scrolling the bar alone', async () => {
  // happy-dom lays nothing out: the bar is 100px wide from 0, and the current tab 50px wide at 250.
  Object.assign(HTMLElement.prototype, {
    getBoundingClientRect(this: HTMLElement) {
      return this.getAttribute('aria-current') === 'page' ? new DOMRect(250, 0, 50, 20) : new DOMRect(0, 0, 100, 20)
    },
    scrollIntoView() {
      throw new Error('the page would scroll to the bar')
    },
  })

  const mounted = await mountComponent(Tabs)

  try {
    expect(mounted.root.querySelector('#tabs')?.scrollLeft).toBe(225)
  }
  finally {
    mounted.unmount()
  }
})

test('carries the params it keeps from the current URL onto each link, marking the link to its path', async () => {
  const mounted = await mountComponent(Tabs)

  try {
    const links = [...mounted.root.querySelectorAll('#kept a')]

    expect(links.map(link => link.getAttribute('href'))).toEqual(['/settings/profile?period=7d', '/settings/keys?period=7d', '/settings/billing?period=7d', '/settings/danger?period=7d'])
    expect(links.map(link => link.getAttribute('aria-current'))).toEqual([null, 'page', null, null])
  }
  finally {
    mounted.unmount()
  }
})

test('centres the current tab once links that arrive after the first render are drawn', async () => {
  Object.assign(HTMLElement.prototype, {
    getBoundingClientRect(this: HTMLElement) {
      return this.getAttribute('aria-current') === 'page' ? new DOMRect(250, 0, 50, 20) : new DOMRect(0, 0, 100, 20)
    },
  })

  const mounted = await mountComponent(TabsLater)

  try {
    expect(mounted.root.querySelector('.kui-tab-nav')).toBeNull()
    ;(globalThis as unknown as { deliverTabs: () => void }).deliverTabs()
    await settle()
    expect(mounted.root.querySelector('.kui-tab-nav')?.scrollLeft).toBe(225)
  }
  finally {
    mounted.unmount()
  }
})

test('a vertical bar moves the focus with ArrowUp and ArrowDown, wrapping, and leaves ArrowLeft and ArrowRight', async () => {
  const mounted = await mountComponent(Tabs)

  try {
    const bar = mounted.root.querySelector<HTMLElement>('#vertical')!
    const links = [...bar.querySelectorAll<HTMLElement>('a')]
    const press = (name: string) => {
      const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })

      document.activeElement!.dispatchEvent(event)

      return event
    }

    expect(bar.getAttribute('data-orientation')).toBe('vertical')

    links[0]!.focus()

    expect(press('ArrowRight').defaultPrevented).toBe(false)
    expect(press('ArrowDown').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(links[1] ?? null)

    press('ArrowUp')
    press('ArrowUp')

    expect(document.activeElement).toBe(links.at(-1) ?? null)
  }
  finally {
    mounted.unmount()
  }
})
