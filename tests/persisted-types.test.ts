import type { Signal } from '../src/runtime'
import { expect, it } from 'bun:test'
import { persisted } from '../src/runtime'

it('types a persisted signal as the union of the values it names, and refuses a default outside them', () => {
  const theme: Signal<'light' | 'dark'> = persisted('theme', 'light', { values: ['light', 'dark'] })
  const size: Signal<1 | 2 | 3> = persisted('size', 2, { values: [1, 2, 3], storage: 'local' })
  const kept: Signal<'a' | 'b'> = persisted('kept', 'b', { values: ['a', 'b'], maxAge: '30d' })
  const named = persisted<'light' | 'dark'>('named', 'dark', { values: ['light', 'dark'] })

  // @ts-expect-error the default must be one of the values
  persisted('outside', 'blue', { values: ['light', 'dark'] })

  // @ts-expect-error a value the signal is set to must be one of the values
  theme.set('blue')

  // @ts-expect-error local storage keeps no time
  persisted('local', 'a', { values: ['a', 'b'], storage: 'local', maxAge: '30d' })

  expect([theme, size, kept, named]).toHaveLength(4)
})

it('leaves a persisted signal without values typed from its default, or from the type given', () => {
  const free: Signal<string> = persisted('free', 'x')
  const given = persisted<'a' | 'b'>('given', 'a')
  const count: Signal<number> = persisted('count', 0, { storage: 'local' })

  expect([free, given, count]).toHaveLength(3)
})
