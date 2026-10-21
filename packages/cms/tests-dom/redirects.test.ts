import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

type Added = [string, string, number]

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function open(props: Record<string, unknown>) {
  const calls: Added[] = []

  mounted = await mountComponent('../../src/components/add-redirect.kay', { path: '/old', onAdd: async (from: string, to: string, status: number) => {
    calls.push([from, to, status])
  }, listId: 'sites', ...props })

  return { root: mounted.root, calls }
}

const button = (root: ParentNode, label: string) => [...root.querySelectorAll('button')].find(item => item.textContent?.trim() === label)

async function type(root: ParentNode, text: string): Promise<void> {
  const box = root.querySelector('input[list]') as HTMLInputElement

  box.value = text
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}

test('the target box offers the site\'s paths and adds a 307, or a 308 once Permanent is ticked', async () => {
  const { root, calls } = await open({})

  expect(root.querySelector('input[list]')?.getAttribute('list')).toBe('sites')
  expect(button(root, 'Add redirect')?.disabled).toBe(true)

  await type(root, ' /new ')
  button(root, 'Add redirect')?.click()
  await settle()
  ;(root.querySelector('input[type="checkbox"]') as HTMLInputElement).click()
  await settle()
  button(root, 'Add redirect')?.click()
  await settle()

  expect(calls).toEqual([['/old', '/new', 307], ['/old', '/new', 308]])
})

test('Gone answers 410 with no target, whatever the box holds', async () => {
  const { root, calls } = await open({})

  await type(root, '/new')
  button(root, 'Gone')?.click()
  await settle()

  expect(calls).toEqual([['/old', '', 410]])
})

test('editing starts at the redirect\'s target and status, and saves', async () => {
  const { root, calls } = await open({ editing: true, to: '/kept', status: 308 })

  expect((root.querySelector('input[list]') as HTMLInputElement).value).toBe('/kept')
  expect((root.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true)
  expect(button(root, 'Add redirect')).toBeUndefined()
  button(root, 'Save')?.click()
  await settle()

  expect(calls).toEqual([['/old', '/kept', 308]])
})

test('a redirect that was a 410 starts with an empty box, which Save refuses until a target is typed', async () => {
  const { root } = await open({ editing: true, to: '', status: 410 })

  expect((root.querySelector('input[list]') as HTMLInputElement).value).toBe('')
  expect(button(root, 'Save')?.disabled).toBe(true)
})

test('a suggested target is added in one click, with its status', async () => {
  const { root, calls } = await open({ suggested: '/blog/post' })

  expect(root.querySelector('input[list]')).toBeNull()
  button(root, 'Add redirect')?.click()
  await settle()

  expect(calls).toEqual([['/old', '/blog/post', 307]])
})
