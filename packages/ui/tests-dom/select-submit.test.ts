import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function filter() {
  mounted = await mountComponent('src/components/submitting-select.kay', {})

  const { root } = mounted
  const select = root.querySelector<HTMLSelectElement>('#kind')!
  const posts = () => root.querySelector('#posts')!.textContent
  const choose = async (value: string) => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
  }
  const key = async (name: string) => {
    select.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
    await settle()
  }

  return { select, posts, choose, key }
}

test('a Select with submit posts once a mouse pick lands', async () => {
  const { select, posts, choose } = await filter()

  select.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  await choose('b')

  expect(posts()).toBe('1')
})

test('a Select with submit does not post on each arrow key, but once on Enter', async () => {
  const { posts, choose, key } = await filter()

  await key('ArrowDown')
  await choose('b')
  await key('ArrowDown')
  await choose('c')

  expect(posts()).toBe('0')

  await key('Enter')

  expect(posts()).toBe('1')

  await key('Enter')

  expect(posts()).toBe('1')
})

test('a Select with submit posts a keyboard pick once it loses focus, and not again', async () => {
  const { select, posts, choose, key } = await filter()

  await key('ArrowDown')
  await choose('b')

  expect(posts()).toBe('0')

  select.dispatchEvent(new FocusEvent('blur'))
  await settle()
  select.dispatchEvent(new FocusEvent('blur'))
  await settle()

  expect(posts()).toBe('1')
})

test('a pointer press after a key makes the next pick post at once', async () => {
  const { select, posts, choose, key } = await filter()

  await key('ArrowDown')
  select.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  await choose('c')

  expect(posts()).toBe('1')
})

test('a pick from the list a key opened posts at once, since that change arrives with no key left to wait for', async () => {
  const { posts, choose, key } = await filter()

  await key(' ')
  await choose('c')

  expect(posts()).toBe('1')
})

test('a Select with submit still hands the page\'s own key, pointer and blur handlers their events', async () => {
  const heard: string[] = []

  mounted = await mountComponent('src/components/submitting-select.kay', { heard })

  const select = mounted.root.querySelector<HTMLSelectElement>('#kind')!

  select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  select.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  select.dispatchEvent(new FocusEvent('blur'))

  expect(heard).toEqual(['keydown', 'pointerdown', 'blur'])
})

test('a Select without submit still hands the page\'s own handlers their events and never posts', async () => {
  const heard: string[] = []

  mounted = await mountComponent('src/components/submitting-select.kay', { heard, submit: false })

  const select = mounted.root.querySelector<HTMLSelectElement>('#kind')!

  select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  select.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  select.value = 'b'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  select.dispatchEvent(new FocusEvent('blur'))
  await settle()

  expect(heard).toEqual(['keydown', 'pointerdown', 'blur'])
  expect(mounted.root.querySelector('#posts')!.textContent).toBe('0')
})
