import { existsSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
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
  expect(plain.root.querySelector('.kui-card')?.className).toStartWith('kui-card ')

  const app = join(import.meta.dir, '..', 'tests', 'restyle-app')
  const link = join(app, 'node_modules', '@kaynooo', 'kayjs-ui')

  if (!existsSync(link)) {
    await mkdir(dirname(link), { recursive: true })
    await symlink(relative(dirname(link), join(import.meta.dir, '..')), link)
  }

  process.env.KAY_ROOT = app

  const restyled = await mountComponent(library('card'), { title: 'x' })

  mounted.push(restyled)
  const classes = (selector: string) => (restyled.root.querySelector(selector)?.className ?? '').split(' ')

  expect(classes('.kui-card')).toContain('rounded-xl')
  expect(classes('[data-part=head]')).toContain('p-6')
})

test('an inline ConfirmDelete draws its armed pair with the restyle once a click arms it', async () => {
  const app = join(import.meta.dir, '..', 'tests', 'restyle-app')

  process.env.KAY_ROOT = app

  const confirm = await mountComponent(library('confirm-delete'), { message: 'Sure?', failure: 'Failed', ask: 'inline', trigger: 'button', onConfirm: () => undefined })

  mounted.push(confirm)
  expect(confirm.root.querySelector('.kui-confirm-delete-armed')).toBeNull()

  confirm.root.querySelector('button')?.click()
  await settle()

  expect(confirm.root.querySelector('.kui-confirm-delete-armed')?.className).toBe('kui-confirm-delete-armed gap-2')
})
