import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { queryParam } from '../src/runtime'
import { startNavigation } from '../src/runtime/navigate'
import { navigation } from '../src/runtime/navigation'

const setURL = (url: string) => (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url)

describe('a traversal between the entries a pushing query param wrote', () => {
  beforeAll(() => {
    GlobalRegistrator.register()
    setURL('http://localhost/tabs?tab=a')
    startNavigation({ hydrate: () => undefined, dispose: () => undefined })
  })
  afterAll(async () => GlobalRegistrator.unregister())

  it('moves the signals and restores the scroll of the entry, leaving the page and the app\'s own popstate listeners alone', () => {
    const tab = queryParam('tab', { history: 'push' })
    const scroll = spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    let heard = 0
    const listener = () => heard++

    window.addEventListener('popstate', listener)

    try {
      tab.set('b')
      expect(history.state).toMatchObject({ kay: true, kayq: navigation.page })

      setURL('http://localhost/tabs?tab=a')
      window.dispatchEvent(new PopStateEvent('popstate', { state: { kay: true, at: 0, scroll: [0, 40], kayq: navigation.page } }))
      expect(tab()).toBe('a')
      expect(navigation.shown).toBe('http://localhost/tabs?tab=a')
      expect(scroll).toHaveBeenCalledWith(0, 40)
      expect(heard).toBe(1)
    }
    finally {
      window.removeEventListener('popstate', listener)
      scroll.mockRestore()
    }
  })

  it('asks the leave guards first, as a traversal between entries of one path does', () => {
    const tab = queryParam('tab', { history: 'push' })
    const go = spyOn(history, 'go').mockImplementation(() => undefined)

    navigation.before = () => false

    try {
      // Read first: outside a browser build the signal loads the address on its first use.
      expect(tab()).toBe('a')
      tab.set('c')
      setURL('http://localhost/tabs?tab=a')
      window.dispatchEvent(new PopStateEvent('popstate', { state: { kay: true, at: navigation.at - 1, scroll: [0, 0], kayq: navigation.page } }))
      expect(go).toHaveBeenCalledTimes(1)
      expect(tab()).toBe('c')
    }
    finally {
      navigation.before = undefined
      go.mockRestore()
    }
  })
})
