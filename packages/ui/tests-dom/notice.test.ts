import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { ApiError, signal } from 'kay'
import { mountComponent, settle } from 'kay/test'
import Notices from '../tests/fixture/src/components/notices.kay'
import { click } from './dom'

let mounted: Mounted | undefined
let dismissed = 0

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  dismissed = 0
})

async function root() {
  mounted = await mountComponent(Notices, { onDismiss: () => dismissed++, sourced: { error: () => undefined, pending: () => false, retry: () => undefined } })

  return mounted.root
}

const box = (page: Element, id: string) => page.querySelector<HTMLElement>(`#${id} .kui-notice`)!

test('a notice with nothing added keeps its markup: text in the box, no icon, body, actions or button', async () => {
  const page = await root()

  expect(box(page, 'plain').children).toHaveLength(0)
  expect(box(page, 'plain').textContent).toBe('Plain')
  expect(box(page, 'plain').hasAttribute('data-framed')).toBe(false)
})

test('an icon draws a part before the body, the tone\'s own for true', async () => {
  const page = await root()

  expect([...box(page, 'toned').children].map(child => child.getAttribute('data-part'))).toEqual(['icon', 'body'])
  expect([...box(page, 'custom').children].map(child => child.getAttribute('data-part'))).toEqual(['icon', 'body'])
  expect(box(page, 'toned').querySelector('[data-part="body"]')?.textContent).toBe('Toned')
})

test('an actions block is drawn after the body', async () => {
  const page = await root()

  expect([...box(page, 'acting').children].map(child => child.getAttribute('data-part'))).toEqual(['body', 'actions'])
  expect(box(page, 'acting').querySelector('[data-part="actions"] #retry')).not.toBeNull()
})

test('the close button hides the notice and tells onDismiss', async () => {
  const page = await root()

  expect(box(page, 'closable').hidden).toBe(false)

  click(box(page, 'closable').querySelector('button[aria-label="Dismiss"]'))
  await settle()

  expect(box(page, 'closable').hidden).toBe(true)
  expect(dismissed).toBe(1)
})

test('a controlled notice follows open, hides on its button and shows again when the page sets open anew', async () => {
  const page = await root()

  expect(box(page, 'controlled').hidden).toBe(false)

  click(box(page, 'controlled').querySelector('button[aria-label="Dismiss"]'))
  await settle()

  expect(box(page, 'controlled').hidden).toBe(true)
  expect(box(page, 'hidden').hidden).toBe(true)

  click(page.querySelector('#show'))
  await settle()

  expect(box(page, 'controlled').hidden).toBe(false)
})

test('a caller\'s hidden attribute still hides a notice that is not controlled', async () => {
  const page = await root()

  expect(page.querySelector<HTMLElement>('#forced-hidden')!.hasAttribute('hidden')).toBe(true)
})

test('a source shows its error with a retry, hides on success, and the button waits while it is pending', async () => {
  const error = signal<ApiError | undefined>(undefined)
  const pending = signal(false)
  let retried = 0

  mounted = await mountComponent(Notices, { onDismiss: () => undefined, sourced: { error, pending, retry: () => retried++ } })

  const notice = () => mounted!.root.querySelector<HTMLElement>('#sourced .kui-notice')!

  expect(notice().hidden).toBe(true)

  error.set(new ApiError(503, 'Unavailable'))
  await settle()

  expect(notice().hidden).toBe(false)
  expect(notice().getAttribute('role')).toBe('alert')
  expect(notice().textContent).toContain('Unavailable')

  const retry = notice().querySelector<HTMLButtonElement>('button')!

  click(retry)

  expect(retried).toBe(1)

  pending.set(true)
  await settle()

  expect(notice().querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)

  error.set(undefined)
  await settle()

  expect(notice().hidden).toBe(true)
})
