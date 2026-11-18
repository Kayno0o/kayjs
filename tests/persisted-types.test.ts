import type { Signal } from '../src/runtime'
import { expect, it } from 'bun:test'
import { persisted, queryParam } from '../src/runtime'

it('types a persisted signal as the union of the values it names, and refuses a default outside them', () => {
  const theme: Signal<'light' | 'dark'> = persisted.cookie('theme', 'light', { values: ['light', 'dark'] })
  const size: Signal<1 | 2 | 3> = persisted.local('size', 2, { values: [1, 2, 3] })
  const kept: Signal<'a' | 'b'> = persisted.cookie('kept', 'b', { values: ['a', 'b'], maxAge: '30d' })
  const named = persisted.cookie<'light' | 'dark'>('named', 'dark', { values: ['light', 'dark'] })

  // @ts-expect-error the default must be one of the values
  persisted.cookie('outside', 'blue', { values: ['light', 'dark'] })

  // @ts-expect-error a value the signal is set to must be one of the values
  theme.set('blue')

  // @ts-expect-error local storage keeps no time
  persisted.local('local', 'a', { values: ['a', 'b'], maxAge: '30d' })

  expect([theme, size, kept, named]).toHaveLength(4)
})

it('types each entry of persisted by its own options', () => {
  const theme: Signal<'light' | 'dark'> = persisted.cookie('theme', 'light', { values: ['light', 'dark'], maxAge: '30d' })
  const size: Signal<1 | 2 | 3> = persisted.local('size', 2, { values: [1, 2, 3], sync: false })
  const step: Signal<'a' | 'b'> = persisted.session('step', 'a', { values: ['a', 'b'] })
  const draft: Signal<string> = persisted.local('draft', '')
  const count: Signal<number> = persisted.session('count', 0)

  // @ts-expect-error the default must be one of the values
  persisted.session('outside', 'blue', { values: ['light', 'dark'] })

  // @ts-expect-error a web storage keeps no time
  persisted.local('time', 'a', { maxAge: '30d' })

  // @ts-expect-error a web storage keeps no time
  persisted.session('time', 'a', { maxAge: '30d' })

  // @ts-expect-error a cookie has no history
  persisted.cookie('history', 'a', { history: 'push' })

  // @ts-expect-error a param of the URL is not synced between tabs
  queryParam('sync', { default: 'a', sync: false })

  // @ts-expect-error each entry is its own storage
  persisted.local('storage', 'a', { storage: 'cookie' })

  expect([theme, size, step, draft, count]).toHaveLength(5)
})

it('leaves a persisted signal without values typed from its default, or from the type given', () => {
  const free: Signal<string> = persisted.cookie('free', 'x')
  const given = persisted.cookie<'a' | 'b'>('given', 'a')
  const count: Signal<number> = persisted.local('count', 0)

  expect([free, given, count]).toHaveLength(3)
})

it('types queryParam by its default and its values', () => {
  const open: Signal<string | undefined> = queryParam('open')
  const found: Signal<string> = queryParam('q', { default: '' })
  const page = queryParam<number>('page', { default: 1 })
  const tab: Signal<'site' | 'logs'> = queryParam('tab', { default: 'site', values: ['site', 'logs'], history: 'push' })
  const maybe: Signal<'a' | 'b' | undefined> = queryParam('maybe', { values: ['a', 'b'] })

  // @ts-expect-error the default must be one of the values
  queryParam('outside', { default: 'blue', values: ['site', 'logs'] })

  // @ts-expect-error a value the signal is set to must be one of the values
  tab.set('blue')

  expect([open, found, page, tab, maybe]).toHaveLength(5)
})
