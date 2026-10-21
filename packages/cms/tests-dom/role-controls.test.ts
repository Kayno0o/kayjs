import type { Mounted } from 'kay/test'
import type { Field } from '../src/fields'
import type { ScreenCollection } from '../src/kay/contract'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { createDrafts } from '../src/drafts'

const REFUSAL = 'Your role may not do this: publish or unpublish'
const schema = { type: 'object', properties: { title: { type: 'string' }, draft: { type: 'boolean' }, publishAt: { type: 'string', format: 'date' }, endsAt: { type: 'string', format: 'date' } } }
const collection = { name: 'posts', title: 'Posts', kind: 'folder', localized: false, components: [], schema, draftField: 'draft', publishField: 'publishAt', unpublishField: 'endsAt', body: {} } as unknown as ScreenCollection
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  ;(globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.()
})

async function field(name: string, denied?: Record<string, string>): Promise<HTMLElement> {
  mounted = await mountComponent('src/components/entry-field-probe.kay', { name, collection, denied })
  await settle()

  return mounted.root
}

test('the draft flag and the publish and end dates are locked with the refusal as tooltip for a role that may not publish, other fields staying editable', async () => {
  for (const name of ['draft', 'publishAt', 'endsAt']) {
    const root = await field(name, { publish: REFUSAL })
    const locked = root.querySelector<HTMLFieldSetElement>('fieldset.kcms-locked')!

    expect(locked.disabled).toBe(true)
    expect(locked.getAttribute('data-tooltip')).toBe(REFUSAL)
    expect(locked.querySelector(`[data-kcms-path="${name}"]`)).not.toBeNull()
    mounted?.unmount()
  }

  const title = await field('title', { publish: REFUSAL })

  expect(title.querySelector('fieldset.kcms-locked')).toBeNull()
  mounted?.unmount()

  const open = await field('publishAt', { upload: 'no uploads' })

  expect(open.querySelector('fieldset.kcms-locked')).toBeNull()
})

class CountingRequest {
  static opened = 0
  upload = {}
  open = () => {
    CountingRequest.opened++
  }

  setRequestHeader = () => undefined
  send = () => undefined
  getAllResponseHeaders = () => ''
  abort = () => undefined
}

const PICTURE = () => new File([new Uint8Array(10)], 'a.png', { type: 'image/png' })

// Drops an image on the Markdown box, answering whether the box took it as an upload.
async function dropped(root: HTMLElement): Promise<boolean> {
  const event = Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: { files: [PICTURE()] } })

  root.querySelector('textarea')!.dispatchEvent(event)
  await settle()

  return event.defaultPrevented
}

let asked = 0

async function withRole(denied: Record<string, string>, open: () => Promise<HTMLElement>): Promise<boolean> {
  const request = globalThis.XMLHttpRequest

  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    asked++

    return Response.json({ denied })
  }) as unknown as typeof fetch)
  Object.assign(globalThis, { XMLHttpRequest: CountingRequest })

  try {
    const root = await open()

    await Bun.sleep(20)
    await settle()

    return await dropped(root)
  }
  finally {
    Object.assign(globalThis, { XMLHttpRequest: request })
  }
}

const MARKDOWN: Field = { key: 'tags', label: 'Notes', hint: undefined, required: false, kind: 'markdown' }

async function markdownField(): Promise<HTMLElement> {
  const drafts = createDrafts({ show: async () => ({}) })

  drafts.open({ collection: 'posts', slug: 'hello', data: { tags: '' } })
  mounted = await mountComponent('src/components/list-field.kay', { drafts, field: MARKDOWN })

  return mounted.root
}

async function bodyField(): Promise<HTMLElement> {
  mounted = await mountComponent('src/components/entry-body-probe.kay', { collection })

  return mounted.root
}

test.each([['a Markdown field', markdownField], ['the entry\'s body', bodyField]])('%s takes no dropped image for a role that may not upload, and does for one that may', async (_name, open) => {
  expect(await withRole({ upload: 'Your role may not do this: upload' }, open)).toBe(false)
  mounted?.unmount()
  expect(await withRole({}, open)).toBe(true)
})

test('the entry\'s body reads the role from the one question its form asked', async () => {
  asked = 0
  expect(await withRole({ upload: 'Your role may not do this: upload' }, bodyField)).toBe(false)
  expect(asked).toBe(1)
})

test('the role is asked again by every field that opens, so a role changed meanwhile shows without a reload', async () => {
  expect(await withRole({}, markdownField)).toBe(true)
  mounted?.unmount()
  expect(await withRole({ upload: 'Your role may not do this: upload' }, markdownField)).toBe(false)
})
