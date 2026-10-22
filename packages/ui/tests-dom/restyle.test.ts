import { join } from 'node:path'
import process from 'node:process'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import { library } from './dom'

const fixture = process.env.KAY_ROOT
const mounted: { unmount: () => void }[] = []

afterEach(() => {
  for (const one of mounted.splice(0))
    one.unmount()

  process.env.KAY_ROOT = fixture
})

// The fixture app has no `src/ui.ts`, so a component mounts as the library draws it; the restyle app has one, which `mountComponent` merges as a build does.
test('mountComponent applies the src/ui.ts of the project it mounts from', async () => {
  const plain = await mountComponent(library('card'), { title: 'x' })

  mounted.push(plain)
  expect(plain.root.querySelector('.kui-card')?.className).toBe('kui-card')

  process.env.KAY_ROOT = join(import.meta.dir, '..', 'tests', 'restyle-app')

  const restyled = await mountComponent(library('card'), { title: 'x' })

  mounted.push(restyled)
  expect(restyled.root.querySelector('.kui-card')?.className).toBe('kui-card rounded-xl')
  expect(restyled.root.querySelector('.kui-card-head')?.className).toBe('kui-card-head p-6')
})
