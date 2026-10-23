import type { Mounted } from 'kay/test'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

let mounted: Mounted | undefined
let dirty = false
let draft = false

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  dirty = false
  draft = false
  mock.restore()
})

const MAIL = { subject: 'Hello', html: '<p>Hi</p>', text: 'Hi', subscribers: 42 }

function server() {
  return spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL | Request) => String(url).endsWith('/send') ? Response.json({ id: 'b1', recipients: 42 }) : Response.json(MAIL)) as unknown as typeof fetch)
}

async function open(denied: Record<string, string> = {}): Promise<void> {
  const form = { collection: { name: 'posts' }, stored: { slug: 'hello' }, dirty: () => dirty, saving: () => false, isDraft: () => draft }

  mounted = await mountComponent('../../src/components/entry-newsletter.kay', { form, denied })
  await settle()
}

async function pause(): Promise<void> {
  for (let wait = 0; wait < 10; wait++) {
    await Bun.sleep(5)
    await settle()
  }
}

const labelled = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label)
// A control the person may not use sits in a wrapper that carries the reason as its tooltip.
const refusedWith = (label: string) => [...document.querySelectorAll('.kcms-refused')].find(item => item.textContent?.trim() === label)

test('the button is disabled with the reason while edits are unsaved', async () => {
  dirty = true
  await open()

  expect(refusedWith('Newsletter')?.getAttribute('data-tooltip')).toBe('Save or reset your edits first')
  expect(refusedWith('Newsletter')?.querySelector('button')?.disabled).toBe(true)
})

test('the button is disabled with the role\'s refusal, which comes before the unsaved edits', async () => {
  dirty = true
  await open({ publish: 'Your role may not do this: publish or unpublish' })

  expect(refusedWith('Newsletter')?.getAttribute('data-tooltip')).toBe('Your role may not do this: publish or unpublish')
  expect(refusedWith('Newsletter')?.querySelector('button')?.disabled).toBe(true)
})

test('a saved entry opens the dialog, which previews the mail and asks twice before sending, the second click naming the subscriber count', async () => {
  const fetched = server()

  await open()
  labelled('Newsletter')!.click()
  await pause()

  expect(document.body.textContent).toContain('Hello')
  expect(String(fetched.mock.calls[0]![0])).toContain('/preview')
  expect(labelled('Yes, send to 42 subscribers')).toBeUndefined()

  labelled('Send to the list')!.click()
  await pause()

  expect(fetched.mock.calls.some(([url]) => String(url).endsWith('/send'))).toBe(false)
  expect(labelled('Yes, send to 42 subscribers')).toBeDefined()

  labelled('Yes, send to 42 subscribers')!.click()
  await pause()

  expect(fetched.mock.calls.some(([url]) => String(url).endsWith('/send'))).toBe(true)
})

test('a draft cannot be sent, with the reason, but can be tested', async () => {
  draft = true
  server()
  await open()
  labelled('Newsletter')!.click()
  await pause()

  expect(refusedWith('Send to the list')?.getAttribute('data-tooltip')).toBe('Publish the entry before sending it to the list')
  expect(labelled('Send me a test')?.disabled).toBe(false)
})
