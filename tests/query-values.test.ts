import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { persisted } from '../src/runtime/persisted'
import { root } from '../src/runtime/reactive'

const setURL = (url: string) => (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url)
const navigation = async () => (await import('../src/runtime/navigation')).navigation

beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/page' }))
afterAll(async () => GlobalRegistrator.unregister())

describe('persisted.query values with no schema naming the param', () => {
  it('match the text of a number or a boolean, and give back the value', () => {
    setURL('http://localhost/page?page=2&on=true&other=9')

    root(() => {
      expect(persisted.query('page', 1, { values: [1, 2, 3] })()).toBe(2)
      expect(persisted.query('on', false, { values: [true, false] })()).toBe(true)
      expect(persisted.query('other', 1, { values: [1, 2, 3] })()).toBe(1)
    })
  })

  it('still match a string, and refuse text none of them spells', () => {
    setURL('http://localhost/page?tab=logs&bad=x')

    root(() => {
      expect(persisted.query('tab', 'site', { values: ['site', 'logs'] })()).toBe('logs')
      expect(persisted.query('bad', 'site', { values: ['site', 'logs'] })()).toBe('site')
    })
  })
})

describe('persisted.query written empty', () => {
  it('keeps an empty string or list in the URL when the default is not empty, so a reload reads it', async () => {
    setURL('http://localhost/page')

    root(() => {
      const tags = persisted.query<string[]>('tags', ['a'])
      const q = persisted.query('q', 'x')

      tags.set([])
      q.set('')
    })
    ;(await navigation()).flush?.()
    expect(location.search).toBe('?tags=&q=')

    root(() => {
      expect(persisted.query<string[]>('tags', ['a'])()).toEqual([])
      expect(persisted.query('q', 'x')()).toBe('')
    })
  })

  it('leaves an empty value out when the default is empty too', async () => {
    setURL('http://localhost/page')

    root(() => {
      persisted.query('s', '').set('')
      persisted.query<string[]>('l', []).set([])
    })
    ;(await navigation()).flush?.()
    expect(location.search).toBe('')
  })
})
