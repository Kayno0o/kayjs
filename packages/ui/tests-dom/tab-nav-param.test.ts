import { describe, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import ParamTabs from '../tests/fixture/src/components/param-tabs.kay'
import Tabs from '../tests/fixture/src/components/tabs.kay'

async function open(search: string) {
  ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://localhost/host${search}`)

  return mountComponent(ParamTabs)
}

const read = (root: Element, id: string) => [...root.querySelectorAll(`#${id} a`)].map(link => [link.getAttribute('href'), link.getAttribute('aria-current')])

test('marks a link current on the pages under its path or its listed paths', async () => {
  const mounted = await mountComponent(Tabs)

  try {
    expect([...mounted.root.querySelectorAll('#sub a')].map(link => link.getAttribute('aria-current'))).toEqual(['page', null])
  }
  finally {
    mounted.unmount()
  }
})

describe('tabs of a query param', () => {
  test('link to the page with the param set and the others kept, the one the address names being current', async () => {
    const mounted = await open('?tab=hosts&period=7d')

    try {
      expect(read(mounted.root, 'first')).toEqual([['/host?tab=findings&period=7d', null], ['/host?tab=hosts&period=7d', 'page'], ['/host?tab=ports&period=7d', null]])
    }
    finally {
      mounted.unmount()
    }
  })

  test('mark the first tab current while the param is left out or names no tab', async () => {
    for (const search of ['?period=7d', '?tab=nothing']) {
      const mounted = await open(search)

      try {
        expect(read(mounted.root, 'first').map(([, current]) => current)).toEqual(['page', null, null])
      }
      finally {
        mounted.unmount()
      }
    }
  })

  test('with a paramDefault leave the param out of its tab and mark that tab current without the param', async () => {
    const mounted = await open('?period=7d')

    try {
      expect(read(mounted.root, 'defaulted')).toEqual([['/host?period=7d&tab=findings', null], ['/host?period=7d', 'page'], ['/host?period=7d&tab=ports', null]])
    }
    finally {
      mounted.unmount()
    }
  })
})
