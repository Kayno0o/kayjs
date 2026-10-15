import { afterEach, expect, test } from 'bun:test'
import { mount } from 'kay/test'

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

  const mounted = await mount('src/components/tabs.kay')

  try {
    expect(mounted.root.querySelector('#tabs')?.scrollLeft).toBe(225)
  }
  finally {
    mounted.unmount()
  }
})

test('carries the params it keeps from the current URL onto each link, marking the link to its path', async () => {
  const mounted = await mount('src/components/tabs.kay')

  try {
    const links = [...mounted.root.querySelectorAll('#kept a')]

    expect(links.map(link => link.getAttribute('href'))).toEqual(['/settings/profile?period=7d', '/settings/keys?period=7d', '/settings/billing?period=7d', '/settings/danger?period=7d'])
    expect(links.map(link => link.getAttribute('aria-current'))).toEqual([null, 'page', null, null])
  }
  finally {
    mounted.unmount()
  }
})
