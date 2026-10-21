import type { Mounted } from 'kay/test'
import type { Field, UploadHints } from '../src/fields'
import type { ScreenCollection, StoredEntry } from '../src/kay/contract'
import type { EntryRow } from '../src/listing'
import process from 'node:process'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { inputValue } from '../src/datetime'
import { createDrafts } from '../src/drafts'

const ENTRY = { collection: 'posts', slug: 'hello' }
const TAGS: Field = { key: 'tags', label: 'Tags', hint: undefined, required: false, kind: 'list', numbered: true, item: { key: 0, label: 'Tag', hint: undefined, required: false, kind: 'text' } }
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function open(items: string[]) {
  const drafts = createDrafts({ show: async () => ({}) })

  drafts.open({ ...ENTRY, data: { tags: items } })
  mounted = await mountComponent('src/components/list-field.kay', { drafts, field: TAGS })

  return { drafts, root: mounted.root }
}

const said = () => document.querySelector('[data-kui-announce]')?.textContent?.trim()

test('the buttons of a list item move it, reorder the saved value and say the item by the place it left', async () => {
  const { drafts, root } = await open(['a', 'b', 'c'])

  root.querySelectorAll<HTMLButtonElement>('[data-kcms-row]')[0]!.querySelector<HTMLButtonElement>('[data-kcms-move="down"]')!.click()
  await settle()

  expect(drafts.value(ENTRY, 'tags')).toEqual(['b', 'a', 'c'])
  // The live region speaks after a short first-use delay.
  for (let wait = 0; wait < 50 && (said() ?? '') === ''; wait++)
    await Bun.sleep(20)

  expect(said()).toBe('Moved Item 1 to 2 of 3')
})

test('Alt and Shift with an arrow in a field of an item moves it, and a move past either end changes nothing', async () => {
  const { drafts, root } = await open(['a', 'b', 'c'])
  const rows = () => root.querySelectorAll<HTMLElement>('[data-kcms-row]')
  const press = (row: HTMLElement, key: string) => row.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, shiftKey: true, bubbles: true, cancelable: true }))

  press(rows()[2]!, 'ArrowUp')
  await settle()

  expect(drafts.value(ENTRY, 'tags')).toEqual(['a', 'c', 'b'])

  press(rows()[0]!, 'ArrowUp')
  press(rows()[2]!, 'ArrowDown')
  await settle()

  expect(drafts.value(ENTRY, 'tags')).toEqual(['a', 'c', 'b'])
})

const PEOPLE: Field = { key: 'tags', label: 'People', hint: undefined, required: false, kind: 'list', numbered: true, minItems: 1, maxItems: 3, item: { key: 0, label: 'Person', hint: undefined, required: true, kind: 'group', fields: [{ key: 'name', label: 'Name', hint: undefined, required: false, kind: 'text', default: 'Anon' }, { key: 'role', label: 'Role', hint: undefined, required: true, kind: 'select', options: [{ value: 'a', label: 'A', raw: 'a' }, { value: 'b', label: 'B', raw: 'b' }] }] } }

async function openField(field: Field, data: unknown, issues: { path: string, message: string }[] = []) {
  mounted = await mountComponent('src/components/list-state.kay', { data, field, issues })
  await settle()

  const root = mounted.root
  const drafted = () => JSON.parse(root.querySelector('.drafted')!.textContent) as unknown
  const click = async (selector: string, at = 0) => {
    root.querySelectorAll<HTMLElement>(selector)[at]!.click()
    await settle()
  }

  return { drafted, root, click, rows: () => [...root.querySelectorAll<HTMLElement>('[data-kcms-row]')] }
}

test('a list of strings shows its label once, the rows naming their input for a screen reader only', async () => {
  const { root } = await openField(TAGS, ['a', 'b'])

  expect(root.querySelectorAll('[data-kcms-row][data-compact]').length).toBe(2)
  expect(root.querySelector('legend')?.textContent).toContain('Tags')
  expect(root.querySelectorAll('input')[0]!.closest('label')?.textContent).toContain('Item 1')
  expect(root.querySelector('.kcms-item-head')).toBeNull()
})

test('a list of groups heads each item by its first filled text, folds it away, and keeps the fold on the item when it moves', async () => {
  const { root, click, rows } = await openField(PEOPLE, [{ name: 'Ada', role: 'a' }, { name: '', role: 'b' }])

  expect(root.querySelectorAll('.kcms-item-title').length).toBe(2)
  expect([...root.querySelectorAll('.kcms-item-title')].map(title => title.textContent)).toEqual(['Ada', 'Item 2'])
  await click('.kcms-fold', 0)
  expect(rows()[0]!.querySelector('.kcms-item-body')!.hasAttribute('hidden')).toBe(true)
  expect(rows()[0]!.querySelector('.kcms-fold')!.getAttribute('aria-expanded')).toBe('false')
  await click('[data-kcms-move="down"]', 0)
  expect(rows()[1]!.querySelector('.kcms-item-body')!.hasAttribute('hidden')).toBe(true)
  expect(rows()[0]!.querySelector('.kcms-item-body')!.hasAttribute('hidden')).toBe(false)
  await click('.kcms-fold', 1)
  expect(rows()[1]!.querySelector('.kcms-item-body')!.hasAttribute('hidden')).toBe(false)
})

test('a new item starts from the schema default, a required select left unpicked, and the list shows its count and bounds', async () => {
  const { drafted, root, click } = await openField(PEOPLE, [{ name: 'Ada', role: 'a' }])

  expect(root.textContent).toContain('1 item')
  expect(root.textContent).toContain('Between 1 and 3 items')
  await click('[data-kcms-add]')
  expect(drafted()).toEqual([{ name: 'Ada', role: 'a' }, { name: 'Anon' }])
  expect(root.querySelectorAll('select')[1]!.value).toBe('')
})

test('Add and Duplicate stop at maxItems and Remove at minItems', async () => {
  const { drafted, root, click } = await openField(PEOPLE, [{ name: 'Ada', role: 'a' }])
  const removers = () => [...root.querySelectorAll<HTMLButtonElement>('button[aria-label^="Remove"]')]

  expect(removers()[0]!.disabled).toBe(true)
  await click('[data-kcms-add]')
  await click('button[aria-label^="Duplicate"]', 0)
  expect(drafted()).toHaveLength(3)
  expect(root.querySelector('[data-kcms-add]')).toBeNull()
  expect([...root.querySelectorAll<HTMLButtonElement>('button[aria-label^="Duplicate"]')].every(button => button.disabled)).toBe(true)
  expect(removers().every(button => !button.disabled)).toBe(true)
  await click('button[aria-label^="Remove"]', 2)
  await click('button[aria-label^="Remove"]', 1)
  expect(drafted()).toHaveLength(1)
  expect(removers()[0]!.disabled).toBe(true)
})

test('Duplicate copies an item right after it without sharing it', async () => {
  const { drafted, root, click } = await openField(TAGS, ['a', 'b'])

  await click('button[aria-label^="Duplicate"]', 0)
  expect(drafted()).toEqual(['a', 'a', 'b'])

  const copy = root.querySelectorAll('input')[1]!

  copy.value = 'z'
  copy.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(drafted()).toEqual(['a', 'z', 'b'])
})

test('removing an item can be undone at its place, and focus lands on the item that took its place, else on Add', async () => {
  const { drafted, root, click, rows } = await openField(TAGS, ['a', 'b', 'c'])

  await click('button[aria-label^="Remove"]', 1)
  expect(drafted()).toEqual(['a', 'c'])
  expect(root.querySelector('.kcms-item-removed')?.textContent).toContain('Item 2 removed')
  expect(document.activeElement).toBe(rows()[1]!.querySelector('input'))
  await click('.kcms-item-removed button')
  expect(drafted()).toEqual(['a', 'b', 'c'])
  expect(root.querySelector('.kcms-item-removed')).toBeNull()
  expect(document.activeElement).toBe(rows()[1]!.querySelector('input'))
  await click('button[aria-label^="Remove"]', 2)
  await click('button[aria-label^="Remove"]', 1)
  await click('button[aria-label^="Remove"]', 0)
  expect(drafted()).toEqual([])
  expect(document.activeElement).toBe(root.querySelector('[data-kcms-add]'))
})

test('removing the item before a folded one puts focus on the folded one\'s fold button, which a hidden field cannot take', async () => {
  const { click, rows } = await openField(PEOPLE, [{ name: 'Ada', role: 'a' }, { name: 'Bo', role: 'b' }])

  await click('.kcms-fold', 1)
  await click('button[aria-label^="Remove"]', 0)
  expect(rows()).toHaveLength(1)
  expect(document.activeElement).toBe(rows()[0]!.querySelector('.kcms-fold'))
})

test('a group item is named by its title in every button and in the move announcement', async () => {
  const { root, click } = await openField(PEOPLE, [{ name: 'Ada', role: 'a' }, { name: 'Bo', role: 'b' }])

  expect(root.querySelector('button[aria-label="Remove Ada"]')).not.toBeNull()
  await click('[data-kcms-move="down"]', 0)
  for (let wait = 0; wait < 50 && (said() ?? '') === ''; wait++)
    await Bun.sleep(20)

  expect(said()).toBe('Moved Ada to 2 of 2')
})

test('Add puts focus in the new item', async () => {
  const { root, click, rows } = await openField(TAGS, ['a'])

  await click('[data-kcms-add]')
  expect(rows()).toHaveLength(2)
  expect(document.activeElement).toBe(rows()[1]!.querySelector('input'))
  expect(root.querySelector('.kcms-item-removed')).toBeNull()
})

const ZONE = process.env.TZ

afterEach(() => {
  if (ZONE === undefined)
    delete process.env.TZ
  else
    process.env.TZ = ZONE
})

async function openDate(stored: string | undefined) {
  const drafts = createDrafts({ show: async () => ({}) })
  const field: Field = { key: 'tags', label: 'Publish at', hint: undefined, required: false, kind: 'datetime' }

  drafts.open({ ...ENTRY, data: { tags: stored } })
  mounted = await mountComponent('src/components/list-field.kay', { drafts, field })
  await settle()

  const input = mounted.root.querySelector<HTMLInputElement>('input[type="datetime-local"]')!
  const type = async (text: string) => {
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }

  return { drafts, input, type, hint: () => mounted!.root.textContent }
}

test('a date and time is shown and typed on the wall clock of the editor\'s zone, stored as the instant it names, and cleared with nothing stored', async () => {
  process.env.TZ = 'America/New_York'

  const { drafts, input, type, hint } = await openDate('2026-10-20T08:00:00+02:00')

  expect(input.value).toBe('2026-10-20T02:00')
  expect(hint()).toContain('Time in America/New_York')
  await type('2026-10-21T09:30')
  expect(drafts.value(ENTRY, 'tags')).toBe('2026-10-21T13:30:00.000Z')
  await type('')
  expect(drafts.value(ENTRY, 'tags')).toBeUndefined()
})

test('an editor in UTC sees UTC, and one in a zone with a half hour offset sees it', async () => {
  process.env.TZ = 'UTC'

  const utc = await openDate('2026-10-20T08:00:00+02:00')

  expect(utc.input.value).toBe('2026-10-20T06:00')
  expect(utc.hint()).toContain('Time in UTC')
  mounted?.unmount()
  process.env.TZ = 'Asia/Kolkata'

  const india = await openDate('2026-10-20T08:00:00+02:00')

  expect(india.input.value).toBe('2026-10-20T11:30')
  await india.type('2026-10-20T11:30')
  expect(india.drafts.value(ENTRY, 'tags')).toBe('2026-10-20T06:00:00.000Z')
})

test('a time the clocks of the editor\'s zone skip is stored an hour on, and a repeated one at its first turn', async () => {
  process.env.TZ = 'Europe/Paris'

  const { drafts, type } = await openDate(undefined)

  await type('2026-03-29T02:30')
  expect(drafts.value(ENTRY, 'tags')).toBe('2026-03-29T01:30:00.000Z')
  await type('2026-10-25T02:30')
  expect(drafts.value(ENTRY, 'tags')).toBe('2026-10-25T00:30:00.000Z')
})

const TALKS: ScreenCollection = { name: 'talks', kind: 'folder', localized: false, components: [], publishField: 'at', draftField: 'draft', schema: { properties: { title: { type: 'string' }, at: { type: 'string', format: 'date-time' }, draft: { type: 'boolean' } } } }
const talk = (at: string) => ({ slug: 'talk', locale: undefined, data: { title: 'Talk', at }, draft: false, version: 'v1', url: '/talks/talk' }) as unknown as StoredEntry
const badge = () => (/Scheduled for \d{4}-\d\d-\d\d \d\d:\d\d (?:UTC|GMT[+-][\d:]+)/).exec(mounted!.root.textContent ?? '')?.[0]

test('the scheduled badge of an entry screen names the time in the editor\'s zone and goes when the date passes, with no reload', async () => {
  process.env.TZ = 'Europe/Paris'

  const at = new Date(Date.now() + 1200)

  mounted = await mountComponent('src/components/scheduled-entry.kay', { collection: TALKS, entry: talk(at.toISOString()) })
  await settle()
  expect(badge()).toMatch(new RegExp(`^Scheduled for ${inputValue(at.toISOString(), 'Europe/Paris').replace('T', ' ')} GMT\\+[12]$`))

  for (let wait = 0; badge() !== undefined && wait < 60; wait++) {
    await Bun.sleep(50)
    await settle()
  }

  expect(badge()).toBeUndefined()
})

test('the badge comes back for a date typed ahead and goes for a date typed in the past', async () => {
  process.env.TZ = 'UTC'
  mounted = await mountComponent('src/components/scheduled-entry.kay', { collection: TALKS, entry: talk('2026-10-01T00:00:00Z') })
  await settle()
  expect(badge()).toBeUndefined()

  const input = mounted.root.querySelector<HTMLInputElement>('input[type="datetime-local"]')!
  const type = async (text: string) => {
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }

  await type('2999-10-19T12:01')
  expect(badge()).toBe('Scheduled for 2999-10-19 12:01 UTC')
  await type('2020-10-19T11:00')
  expect(badge()).toBeUndefined()
})

const rowOf = (slug: string, at: string | undefined) => ({ slug, title: slug, draft: false, ...at !== undefined && Date.parse(at) > Date.now() && { scheduledAt: Date.parse(at) } }) as EntryRow
const statusOf = (slug: string) => mounted!.root.querySelector(`tr:has(a[href$="/${slug}"]) .kui-badge`)?.textContent?.trim()

test('the list names a scheduled time in the editor\'s zone, as the entry screen does, and says Published for an entry with none or one that passed', async () => {
  process.env.TZ = 'Europe/Paris'

  const ahead = new Date(Date.now() + 3_600_000).toISOString()

  mounted = await mountComponent('src/components/scheduled-rows.kay', { collection: TALKS, rows: [rowOf('later', ahead), rowOf('live', '2020-01-01'), rowOf('plain', undefined)] })
  await settle()
  expect(statusOf('later')).toMatch(new RegExp(`^Scheduled for ${inputValue(ahead, 'Europe/Paris').replace('T', ' ')} GMT\\+[12]$`))
  expect([statusOf('live'), statusOf('plain')]).toEqual(['Published', 'Published'])
})

test('the list names a time in UTC for an editor in UTC and the offset of a half hour zone', async () => {
  const ahead = '2999-10-19T06:00:00Z'

  process.env.TZ = 'UTC'
  mounted = await mountComponent('src/components/scheduled-rows.kay', { collection: TALKS, rows: [{ ...rowOf('later', ahead), scheduledAt: Date.parse(ahead) }] })
  await settle()
  expect(statusOf('later')).toBe('Scheduled for 2999-10-19 06:00 UTC')
  mounted.unmount()
  process.env.TZ = 'Asia/Kolkata'
  mounted = await mountComponent('src/components/scheduled-rows.kay', { collection: TALKS, rows: [{ ...rowOf('later', ahead), scheduledAt: Date.parse(ahead) }] })
  await settle()
  expect(statusOf('later')).toBe('Scheduled for 2999-10-19 11:30 GMT+5:30')
})

test('the list\'s badge turns to Published when its date passes, with no reload', async () => {
  process.env.TZ = 'Europe/Paris'

  const at = Date.now() + 1200

  mounted = await mountComponent('src/components/scheduled-rows.kay', { collection: TALKS, rows: [{ ...rowOf('later', undefined), scheduledAt: at }] })
  await settle()
  expect(statusOf('later')).toStartWith('Scheduled for ')

  for (let wait = 0; statusOf('later') !== 'Published' && wait < 60; wait++) {
    await Bun.sleep(50)
    await settle()
  }

  expect(statusOf('later')).toBe('Published')
})

const UPLOADED = '/_kay/files/posts/abc.40x30.png'
const PHOTO = (hints: UploadHints = {}): Field => ({ key: 'tags', label: 'Photo', hint: undefined, required: false, kind: 'image', upload: hints })
const sibling = (key: string): Field => ({ key, label: key, hint: undefined, required: false, kind: 'text' })

async function openImage(data: Record<string, unknown>, hints: Parameters<typeof PHOTO>[0] = {}) {
  const drafts = createDrafts({ show: async () => ({}) })

  drafts.open({ ...ENTRY, data })
  mounted = await mountComponent('src/components/list-field.kay', { drafts, field: PHOTO(hints) })
  await settle()

  return { drafts, root: mounted.root }
}

async function openFile(initial: string, options: { image?: boolean, many?: boolean, upload?: UploadHints, alt?: { id: string, value: string, issue?: string, required: boolean }, sizeIssues?: { id: string, message: string }[] } = {}) {
  mounted = await mountComponent('src/components/file-field.kay', { initial, ...options })
  await settle()

  return mounted.root
}

test('the file name of an upload is a link opening it in a new tab, beside a button clearing the field, which brings the path back', async () => {
  const root = await openFile(UPLOADED)
  const link = root.querySelector<HTMLAnchorElement>('a.kcms-file-link')!

  expect(link.getAttribute('href')).toBe(UPLOADED)
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener')
  expect(link.textContent).toBe('abc.40x30.png')
  expect(root.querySelector('.kcms-file-path')).toBeNull()
  root.querySelector<HTMLButtonElement>('.kcms-file-name button')!.click()
  await settle()
  expect(root.querySelector('a.kcms-file-link')).toBeNull()
  expect(root.querySelector('img.kcms-file-preview')).toBeNull()
  expect(root.querySelector('.kcms-file-path')).not.toBeNull()
})

test('a file field links the file too, and the path is offered for an empty field and a typed address, not for an upload the CMS stored', async () => {
  expect((await openFile('/_kay/files/posts/cv.pdf', { image: false })).querySelector('a.kcms-file-link')?.getAttribute('target')).toBe('_blank')
  mounted?.unmount()
  expect((await openFile('')).querySelector('.kcms-file-path')).not.toBeNull()
  mounted?.unmount()

  const typed = await openFile('https://example.com/a.png')

  expect(typed.querySelector('.kcms-file-path')).not.toBeNull()
  expect(typed.querySelector('a.kcms-file-link')?.getAttribute('href')).toBe('https://example.com/a.png')
})

test('an image that cannot be shown says so in place of a broken preview', async () => {
  const root = await openFile('/nowhere.png')

  root.querySelector('img.kcms-file-preview')!.dispatchEvent(new Event('error'))
  await settle()
  expect(root.querySelector<HTMLImageElement>('img.kcms-file-preview')?.hidden).toBe(true)
  expect(root.querySelector('.kcms-file-broken')?.textContent).toBe('This image cannot be shown')
  expect(root.querySelector('a.kcms-file-link')).not.toBeNull()
  // A load that follows brings the preview back.
  root.querySelector('img.kcms-file-preview')!.dispatchEvent(new Event('load'))
  await settle()
  expect(root.querySelector<HTMLImageElement>('img.kcms-file-preview')?.hidden).toBe(false)
  expect(root.querySelector('.kcms-file-broken')).toBeNull()
})

test('an image previews with its alt text, which is edited in place, shown only for a set image and a field with an alt', async () => {
  const withAlt = await openFile(UPLOADED, { alt: { id: 'alt-id', value: 'A cat', required: true } })
  const box = withAlt.querySelector<HTMLInputElement>('label.kcms-file-alt input')!

  expect(withAlt.querySelector('img.kcms-file-preview')?.getAttribute('alt')).toBe('A cat')
  expect(box.value).toBe('A cat')
  // A visible label names the box, and the requirement is said to assistive tech rather than in the label.
  expect(withAlt.querySelector('label.kcms-file-alt')?.textContent).toContain('Alt text')
  expect(box.getAttribute('aria-required')).toBe('true')
  expect(box.id).toBe('alt-id')
  mounted?.unmount()

  const refused = await openFile(UPLOADED, { alt: { id: 'alt-id', value: '', issue: 'Required', required: true } })

  expect(refused.querySelector('label.kcms-file-alt input')?.getAttribute('aria-invalid')).toBe('true')
  expect(refused.querySelector('.kcms-file-error')?.textContent).toBe('Required')
  mounted?.unmount()
  expect((await openFile(UPLOADED)).querySelector('label.kcms-file-alt')).toBeNull()
  mounted?.unmount()
  expect((await openFile('', { alt: { id: 'alt-id', value: '', required: false } })).querySelector('label.kcms-file-alt')).toBeNull()
  mounted?.unmount()

  const optional = await openFile(UPLOADED, { alt: { id: 'alt-id', value: '', required: false } })

  expect(optional.querySelector('label.kcms-file-alt input')?.hasAttribute('aria-required')).toBe(false)
})

test('the field says what it takes: the types, the most it weighs and the pixels an image needs', async () => {
  const root = await openFile('', { upload: { accept: ['image/png', 'image/svg+xml'], maxSize: 2 * 1024 * 1024, minWidth: 800, minHeight: 600 } })

  expect(root.querySelector('.kcms-file-rules')?.textContent).toBe('Accepts PNG, SVG. Up to 2 MB. At least 800 by 600 pixels.')
  expect(root.querySelector('input[type=file]')?.getAttribute('accept')).toBe('image/png,image/svg+xml')
})

test('the alt text of a paired field is written to the field beside the image, and a path sets or drops the size beside it', async () => {
  const hints = { alt: sibling('alt'), width: sibling('width'), height: sibling('height') }
  const { drafts, root } = await openImage({ tags: UPLOADED, alt: 'A cat', width: 1, height: 1 }, hints)
  const alt = root.querySelector<HTMLInputElement>('label.kcms-file-alt input')!

  expect(alt.value).toBe('A cat')
  alt.value = 'A black cat'
  alt.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(drafts.value(ENTRY, 'alt')).toBe('A black cat')
  alt.value = ''
  alt.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(drafts.value(ENTRY, 'alt')).toBeUndefined()
  // Clearing the field leaves no size that would describe the old image.
  root.querySelector<HTMLButtonElement>('.kcms-file-name button')!.click()
  await settle()
  expect([drafts.value(ENTRY, 'tags'), drafts.value(ENTRY, 'width'), drafts.value(ENTRY, 'height')]).toEqual(['', undefined, undefined])
})

test('a typed path in the storage\'s naming gives the size beside it, any other path none', async () => {
  const { drafts, root } = await openImage({ tags: '', width: 9, height: 9 }, { width: sibling('width'), height: sibling('height') })
  const typed = root.querySelector<HTMLInputElement>('.kcms-file-path input')!
  const type = async (text: string) => {
    typed.value = text
    typed.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }

  await type('/_kay/files/posts/zzz.640x480.webp')
  expect([drafts.value(ENTRY, 'width'), drafts.value(ENTRY, 'height')]).toEqual([640, 480])
  await type('https://example.com/a.png')
  expect([drafts.value(ENTRY, 'width'), drafts.value(ENTRY, 'height')]).toEqual([undefined, undefined])
})

// An XMLHttpRequest that goes nowhere until the test says so.
class SlowRequest {
  static instances: SlowRequest[] = []
  static HEADERS_RECEIVED = 2
  upload: { onload?: () => void, onprogress?: (event: { lengthComputable: boolean, loaded: number, total: number }) => void } = {}
  readyState = 0
  status = 200
  response: Blob = new Blob([JSON.stringify({ path: UPLOADED, width: 40, height: 30 })], { type: 'application/json' })
  responseType = ''
  onload?: () => void
  onabort?: () => void
  onerror?: () => void
  ontimeout?: () => void
  onreadystatechange?: () => void
  constructor() {
    SlowRequest.instances.push(this)
  }

  open = () => undefined
  setRequestHeader = () => undefined
  send = () => undefined
  getAllResponseHeaders() {
    return 'content-type: application/json'
  }

  abort() {
    this.onabort?.()
  }
}

// A request the server refuses at once, naming the file it was sent.
class RefusingRequest extends SlowRequest {
  private file = ''

  override send = (body?: unknown): undefined => {
    this.file = body instanceof FormData ? (body.get('file') as File).name : ''
    this.status = 415
    this.response = new Blob([`${this.file} is refused`])
    queueMicrotask(() => this.onload?.())
  }
}

async function drop(root: HTMLElement, file: File) {
  root.querySelector('.kcms-file-drop')!.dispatchEvent(Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: { files: [file] } }))
  await settle()
}

test('an upload shows a progress bar and a button cancelling it, and the field is left as it was', async () => {
  const request = globalThis.XMLHttpRequest

  Object.assign(globalThis, { XMLHttpRequest: SlowRequest })
  SlowRequest.instances = []

  try {
    const { drafts, root } = await openImage({ tags: '' }, { alt: sibling('alt') })

    await drop(root, new File([new Uint8Array(10)], 'a.png', { type: 'image/png' }))
    SlowRequest.instances[0]!.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 })
    await settle()
    expect(root.querySelector<HTMLProgressElement>('progress.kcms-file-progress')?.value).toBe(0.25)
    root.querySelector<HTMLButtonElement>('.kcms-file-drop button[aria-label="Cancel the upload"]')!.click()
    await settle()
    expect(root.querySelector('progress')).toBeNull()
    expect(root.querySelector('.kcms-file-error')).toBeNull()
    expect(drafts.value(ENTRY, 'tags')).toBe('')
  }
  finally {
    Object.assign(globalThis, { XMLHttpRequest: request })
  }
})

test('a failed upload is told by the field, and a landed one sets the path and the size of its image', async () => {
  const request = globalThis.XMLHttpRequest

  Object.assign(globalThis, { XMLHttpRequest: SlowRequest })
  SlowRequest.instances = []

  try {
    const { drafts, root } = await openImage({ tags: '' }, { width: sibling('width'), height: sibling('height') })

    await drop(root, new File([new Uint8Array(10)], 'a.png', { type: 'image/png' }))

    const failing = SlowRequest.instances[0]!

    failing.status = 415
    failing.response = new Blob(['a.png is not a real image/png'])
    failing.onload?.()
    await settle()
    expect(root.querySelector('.kcms-file-error')?.textContent).toContain('a.png is not a real image/png')
    expect(drafts.value(ENTRY, 'tags')).toBe('')

    await drop(root, new File([new Uint8Array(10)], 'b.png', { type: 'image/png' }))
    SlowRequest.instances[1]!.onload?.()
    await settle()
    expect(root.querySelector('.kcms-file-error')).toBeNull()
    expect([drafts.value(ENTRY, 'tags'), drafts.value(ENTRY, 'width'), drafts.value(ENTRY, 'height')]).toEqual([UPLOADED, 40, 30])
  }
  finally {
    Object.assign(globalThis, { XMLHttpRequest: request })
  }
})

test('a typed script address is neither linked nor previewed as one', async () => {
  const root = await openFile('javascript:alert(1)')

  expect(root.querySelector('a.kcms-file-link')?.getAttribute('href') ?? '').not.toMatch(/^javascript:/i)
  expect(root.querySelector('img.kcms-file-preview')?.getAttribute('src') ?? '').not.toMatch(/^javascript:/i)
})

test('typing an address one character at a time never breaks the field, whatever the state it passes through', async () => {
  const root = await openFile('')
  const typed = root.querySelector<HTMLInputElement>('.kcms-file-path input')!

  for (const text of ['h', 'https:', 'https:/', 'https://', '/a/100%', 'https://example.com/a.png']) {
    typed.value = text
    typed.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }

  expect(root.querySelector('a.kcms-file-link')?.textContent).toBe('a.png')
})

test('the zone of a list of images shows and applies the item field\'s own limits', async () => {
  const drafts = createDrafts({ show: async () => ({}) })
  const item: Field = { key: 0, label: 'Photo', hint: undefined, required: false, kind: 'image', upload: { accept: ['image/png'], maxSize: 1024 } }

  drafts.open({ ...ENTRY, data: { tags: [] } })
  mounted = await mountComponent('src/components/list-field.kay', { drafts, field: { key: 'tags', label: 'Photos', hint: undefined, required: false, kind: 'list', numbered: true, item } })
  await settle()
  expect(mounted.root.querySelector('.kcms-file-rules')?.textContent).toBe('Accepts PNG. Up to 1 KB.')
  expect(mounted.root.querySelector('input[type=file]')?.getAttribute('accept')).toBe('image/png')
})

test('clearing an image takes its alt text with it', async () => {
  const { drafts, root } = await openImage({ tags: UPLOADED, alt: 'A cat' }, { alt: sibling('alt') })

  root.querySelector<HTMLButtonElement>('.kcms-file-name button')!.click()
  await settle()
  expect(drafts.value(ENTRY, 'alt')).toBeUndefined()
})

test('an image field built without upload hints, as an app\'s own code may, works as it did', async () => {
  const drafts = createDrafts({ show: async () => ({}) })

  drafts.open({ ...ENTRY, data: { tags: UPLOADED } })
  mounted = await mountComponent('src/components/list-field.kay', { drafts, field: { key: 'tags', label: 'Photo', hint: undefined, required: false, kind: 'image' } })
  await settle()
  mounted.root.querySelector<HTMLButtonElement>('.kcms-file-name button')!.click()
  await settle()
  expect(drafts.value(ENTRY, 'tags')).toBe('')
})

test('the refusal of an image\'s hidden width or height shows beside the image, since no field of the form carries it', async () => {
  const root = await openFile(UPLOADED, { sizeIssues: [{ id: 'w', message: 'Width is required' }, { id: 'h', message: 'Height is required' }] })

  expect([...root.querySelectorAll('.kcms-file-error')].map(item => item.textContent)).toEqual(['Width is required', 'Height is required'])
  expect(root.querySelector('#w')).not.toBeNull()
})

test('a picker that could not list the uploads says so and not that nothing was uploaded, and asks again when opened again', async () => {
  const listing = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response('down', { status: 500 })) as unknown as typeof fetch)

  try {
    const root = await openFile('')
    const pick = root.querySelector<HTMLDetailsElement>('details.kcms-file-pick')!

    pick.open = true
    pick.dispatchEvent(new Event('toggle'))
    await settle()
    expect(root.textContent).toContain('Could not list the uploads')
    expect(root.textContent).not.toContain('Nothing uploaded yet')
  }
  finally {
    listing.mockRestore()
  }
})

test('the zone of a list keeps what each refused file was told', async () => {
  const request = globalThis.XMLHttpRequest

  Object.assign(globalThis, { XMLHttpRequest: RefusingRequest })

  try {
    const root = await openFile('', { many: true })

    root.querySelector('.kcms-file-drop')!.dispatchEvent(Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: { files: [new File([new Uint8Array(10)], 'a.png', { type: 'image/png' }), new File([new Uint8Array(10)], 'b.png', { type: 'image/png' })] } }))
    await settle()
    await settle()

    const told = root.querySelector('.kcms-file-error')?.textContent ?? ''

    expect(told).toContain('a.png is refused')
    expect(told).toContain('b.png is refused')
  }
  finally {
    Object.assign(globalThis, { XMLHttpRequest: request })
  }
})

test('the page asks before it is left while an upload is on its way, and not after', async () => {
  const request = globalThis.XMLHttpRequest

  Object.assign(globalThis, { XMLHttpRequest: SlowRequest })
  SlowRequest.instances = []

  try {
    const { root } = await openImage({ tags: '' })
    const leave = () => {
      const event = new Event('beforeunload', { cancelable: true })

      window.dispatchEvent(event)

      return event.defaultPrevented
    }

    expect(leave()).toBe(false)
    await drop(root, new File([new Uint8Array(10)], 'a.png', { type: 'image/png' }))
    expect(leave()).toBe(true)
    SlowRequest.instances[0]!.onload?.()
    await settle()
    expect(leave()).toBe(false)
  }
  finally {
    Object.assign(globalThis, { XMLHttpRequest: request })
  }
})

const base = { hint: undefined, required: false }

test('a text shows its placeholder, takes its prefix and suffix beside it and counts its length against maxLength', async () => {
  const { root } = await openField({ ...base, key: 'tags', label: 'Price', kind: 'number', placeholder: '600', suffix: '€' }, undefined)
  const input = root.querySelector<HTMLInputElement>('input')!

  expect(input.placeholder).toBe('600')
  expect(root.querySelector('.kcms-adorned')?.textContent?.trim()).toBe('€')

  const mail = await openField({ ...base, key: 'tags', label: 'Mail', kind: 'text', inputType: 'email', limits: { maxLength: 254 } }, 'a@b.fr')
  const box = mail.root.querySelector<HTMLInputElement>('input')!

  expect(box.type).toBe('email')
  expect(box.maxLength).toBe(254)
  expect(mail.root.textContent).toContain('6 / 254')
})

test('an integer refuses the keys of a decimal, cuts a pasted one and leaves the box on a wheel turn', async () => {
  const { root, drafted } = await openField({ ...base, key: 'tags', label: 'Stock', kind: 'integer', limits: { minimum: 0 } }, 3)
  const input = root.querySelector<HTMLInputElement>('input')!
  const key = new KeyboardEvent('keydown', { key: '.', bubbles: true, cancelable: true })

  input.dispatchEvent(key)
  expect(key.defaultPrevented).toBe(true)
  expect(input.min).toBe('0')
  expect(input.getAttribute('inputmode')).toBe('numeric')

  input.value = '4.7'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(drafted()).toBe(4)

  input.focus()
  input.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }))
  expect(document.activeElement).not.toBe(input)
})

test('emptying an optional text unsets it, a required one keeping the empty string for the schema to refuse', async () => {
  const optional = await openField({ ...base, key: 'tags', label: 'Note', kind: 'text' }, 'x')
  const input = optional.root.querySelector<HTMLInputElement>('input')!

  input.value = ''
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(optional.drafted()).toBe(null)
  mounted?.unmount()

  const required = await openField({ ...base, required: true, key: 'tags', label: 'Note', kind: 'text' }, 'x')
  const box = required.root.querySelector<HTMLInputElement>('input')!

  box.value = ''
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(required.drafted()).toBe('')
})

test('a text with rows is a growing textarea of that many rows, and a list of lines is one box a line each', async () => {
  const text = await openField({ ...base, key: 'tags', label: 'Bio', kind: 'textarea', rows: 6 }, '')
  const area = text.root.querySelector<HTMLTextAreaElement>('textarea')!

  expect(area.getAttribute('rows')).toBe('6')
  expect(area.hasAttribute('data-kcms-grow')).toBe(true)
  mounted?.unmount()

  const lines = await openField({ ...base, key: 'tags', label: 'Tags', kind: 'lines' }, ['a', 'b'])
  const box = lines.root.querySelector<HTMLTextAreaElement>('textarea')!

  expect(box.value).toBe('a\nb')
  box.value = 'a\n\nb\n c '
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(lines.drafted()).toEqual(['a', 'b', 'c'])
})

test('a field with a `when` stays hidden until its sibling holds a value', async () => {
  const group: Field = { ...base, key: 'tags', label: 'Link', kind: 'group', fields: [
    { ...base, key: 'url', label: 'Url', kind: 'text' },
    { ...base, key: 'label', label: 'Label', kind: 'text', when: 'url' },
  ] }
  const { root } = await openField(group, {})
  const label = () => root.querySelector<HTMLElement>('[data-kcms-path="tags.label"]')!

  expect(label().hidden).toBe(true)

  const url = root.querySelector<HTMLInputElement>('[data-kcms-path="tags.url"] input')!

  url.value = 'https://a.fr'
  url.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(label().hidden).toBe(false)
})

test('a toggle keeps its hint and its issue', async () => {
  const { root } = await openField({ ...base, key: 'tags', label: 'Featured', kind: 'boolean', hint: 'Shown on the home page' }, false)

  expect(root.textContent).toContain('Shown on the home page')
  expect(root.querySelector('input')!.getAttribute('aria-describedby')).toStartWith('kcms-note-')
  expect(root.querySelector('[aria-live]')?.id).toBe(root.querySelector('input')!.getAttribute('aria-describedby') ?? '')
})

test('a folded item counts its issues in its head, and an unfolded one does not', async () => {
  const { root, click, rows } = await openField(PEOPLE, [{ name: 'Ada', role: 'a' }, { name: 'Bob', role: '' }], [{ path: 'tags.1.role', message: 'Required' }, { path: 'tags.1.name', message: 'Too short' }])

  expect(root.querySelectorAll('.kcms-item-issues').length).toBe(0)
  await click('.kcms-fold', 1)
  expect(rows()[1]!.querySelector('.kcms-item-issues')?.textContent).toBe('2 issues')
  expect(rows()[0]!.querySelector('.kcms-item-issues')).toBeNull()
})

test('Add at the top puts a new item first, and stops at maxItems', async () => {
  const { drafted, root, click } = await openField(PEOPLE, [{ name: 'Ada', role: 'a' }])

  await click('.kcms-list-tools button')
  expect(drafted()).toEqual([{ name: 'Anon' }, { name: 'Ada', role: 'a' }])
  await click('.kcms-list-tools button')
  expect((drafted() as unknown[]).length).toBe(3)
  expect(root.querySelector('.kcms-list-tools button')).toBeNull()
})

test('a list of eight items or more offers a menu to jump to an item', async () => {
  const seven = await openField(TAGS, Array.from({ length: 7 }, (_, i) => `t${i}`))

  expect(seven.root.querySelector('.kcms-list-tools select')).toBeNull()
  mounted?.unmount()

  const { root } = await openField(TAGS, Array.from({ length: 8 }, (_, i) => `t${i}`))
  const menu = root.querySelector<HTMLSelectElement>('.kcms-list-tools select')!

  expect(menu.options.length).toBe(9)
  menu.value = '5'
  menu.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
  expect(root.contains(document.activeElement)).toBe(true)
})

test('a new list item under a minLength is not flagged before it is touched', async () => {
  const field: Field = { ...TAGS, item: { ...TAGS.item, limits: { minLength: 3 } } as Field }
  const { root, click } = await openField(field, ['abcd'])

  await click('[data-kcms-add]')
  expect(root.querySelectorAll('.kui-form-field-issue').length).toBe(0)
})
