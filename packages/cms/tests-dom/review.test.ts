import type { Mounted } from 'kay/test'
import type { Denials } from '../src/access'
import type { ScreenCollection } from '../src/kay/contract'
import type { EntryRow } from '../src/listing'
import type { ReviewView } from '../src/review'
import { afterEach, expect, mock, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import EntryReviewLog from '../src/components/entry-review-log.kay'
import EntryReview from '../src/components/entry-review.kay'
import WithToaster from './with-toaster.kay'

const POSTS = { name: 'posts', title: 'Posts', kind: 'folder', localized: false, components: [], draftField: 'draft', schema: { type: 'object', properties: { title: { type: 'string' }, draft: { type: 'boolean' } } }, review: true } as unknown as ScreenCollection
const WRITER: Denials = { publish: 'Your role may not do this: publish or unpublish', review: 'Your role may not do this: approve or send back an entry in review' }
const REVIEWER: Denials = { publish: 'Your role may not do this: publish or unpublish' }
const OWN = 'You sent this entry for review: another person approves it'
const waiting: ReviewView = { status: 'review', by: 'Wanda', events: [{ at: 1_700_000_000_000, verb: 'submit', by: 'Wanda' }] }
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

interface Given {
  review?: ReviewView | undefined
  draft?: boolean
  denied?: Denials
  dirty?: boolean
  busy?: boolean
}

// The review controls of an entry, with the steps they call recorded.
async function open(given: Given) {
  const steps = { onSubmit: mock(() => undefined), onApprove: mock(() => undefined), onSendBack: mock(async (_note: string) => true) }

  mounted = await mountComponent(EntryReview, { review: undefined, draft: true, dirty: false, busy: false, ...given, ...steps })
  await settle()

  return { root: mounted.root, steps }
}

const buttons = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.closest('dialog'))
const buttonOf = (root: HTMLElement, label: string) => buttons(root).find(button => button.textContent?.trim() === label)
const refusalOf = (button: HTMLButtonElement | undefined) => button?.closest('.kcms-refused')?.getAttribute('data-tooltip')

test('a writer who may not publish submits a draft, and the button is a plain one with no review state', async () => {
  const { root, steps } = await open({ denied: WRITER })
  const submit = buttonOf(root, 'Submit for review')

  expect(submit?.disabled).toBe(false)
  expect(refusalOf(submit)).toBeUndefined()
  expect(buttonOf(root, 'Approve')).toBeUndefined()
  submit!.click()
  expect(steps.onSubmit).toHaveBeenCalledTimes(1)
})

test('Submit for review is not offered to a person who may publish, a published entry, or one already in review', async () => {
  expect(buttonOf((await open({ denied: {} })).root, 'Submit for review')).toBeUndefined()
  mounted?.unmount()
  expect(buttonOf((await open({ denied: WRITER, draft: false })).root, 'Submit for review')).toBeUndefined()
  mounted?.unmount()
  expect(buttonOf((await open({ denied: WRITER, review: waiting })).root, 'Submit for review')).toBeUndefined()
})

test('Submit for review waits for the edits to be saved, with the reason as its tooltip', async () => {
  const { root, steps } = await open({ denied: WRITER, dirty: true })
  const submit = buttonOf(root, 'Submit for review')

  expect(submit?.disabled).toBe(true)
  expect(refusalOf(submit)).toBe('Save or reset your edits first')
  submit!.click()
  expect(steps.onSubmit).not.toHaveBeenCalled()
})

test('a reviewer approves or sends back a draft in review, the badge saying so', async () => {
  const { root, steps } = await open({ denied: REVIEWER, review: waiting })

  expect(root.textContent).toContain('In review')

  const approve = buttonOf(root, 'Approve')

  expect(approve?.disabled).toBe(false)
  expect(buttonOf(root, 'Send back')?.disabled).toBe(false)
  approve!.click()
  expect(steps.onApprove).toHaveBeenCalledTimes(1)
})

test('a role without review sees Approve and Send back disabled with the role\'s reason', async () => {
  const { root, steps } = await open({ denied: WRITER, review: waiting })

  for (const label of ['Approve', 'Send back']) {
    const button = buttonOf(root, label)

    expect(button?.disabled, label).toBe(true)
    expect(refusalOf(button), label).toBe(WRITER.review)
    button!.click()
  }

  expect(steps.onApprove).not.toHaveBeenCalled()
  expect(root.querySelector('dialog[open]')).toBeNull()
})

test('Approve and Send back wait for the edits to be saved', async () => {
  const { root } = await open({ denied: REVIEWER, review: waiting, dirty: true })

  for (const label of ['Approve', 'Send back']) {
    expect(buttonOf(root, label)?.disabled, label).toBe(true)
    expect(refusalOf(buttonOf(root, label)), label).toBe('Save or reset your edits first')
  }
})

test('with the four-eyes rule, the submitter sees Approve disabled with its reason while Send back stays open', async () => {
  const { root, steps } = await open({ denied: REVIEWER, review: { ...waiting, own: true } })
  const approve = buttonOf(root, 'Approve')

  expect(approve?.disabled).toBe(true)
  expect(refusalOf(approve)).toBe(OWN)
  approve!.click()
  expect(steps.onApprove).not.toHaveBeenCalled()
  expect(buttonOf(root, 'Send back')?.disabled).toBe(false)
  expect(refusalOf(buttonOf(root, 'Send back'))).toBeUndefined()
})

test('Send back asks for a note and sends it', async () => {
  const { root, steps } = await open({ denied: REVIEWER, review: waiting })

  buttonOf(root, 'Send back')!.click()
  await settle()

  const dialog = document.querySelector('dialog')!
  const send = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Send back')!
  const note = dialog.querySelector('textarea')!

  expect(send.disabled).toBe(true)
  note.value = 'Shorter title'
  note.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(send.disabled).toBe(false)
  send.click()
  await settle()
  expect(steps.onSendBack).toHaveBeenCalledWith('Shorter title')
})

test('a draft sent back is badged Sent back, and its writer submits it again', async () => {
  const { root } = await open({ denied: WRITER, review: { status: 'sent-back', by: 'Wanda', events: [] } })

  expect(root.textContent).toContain('Sent back')
  expect(buttonOf(root, 'Submit for review')?.disabled).toBe(false)
})

test('the review log lists the steps newest first, and a draft sent back shows the last note above them', async () => {
  const review: ReviewView = { status: 'sent-back', by: 'Wanda', events: [{ at: 1_700_000_000_000, verb: 'submit', by: 'Wanda' }, { at: 1_700_000_100_000, verb: 'send-back', by: 'Rex', note: 'Shorter title' }] }

  mounted = await mountComponent(EntryReviewLog, { review, draft: true })
  await settle()

  const entries = [...mounted.root.querySelectorAll('.kcms-review-event')]

  expect(entries).toHaveLength(2)
  expect(entries[0]!.textContent).toContain('Sent back')
  expect(entries[0]!.textContent).toContain('Rex')
  expect(entries[0]!.textContent).toContain('Shorter title')
  expect(entries[1]!.textContent).toContain('Sent for review')
  expect(mounted.root.querySelector('ol')?.getAttribute('aria-label')).toBe('Review')
  expect(mounted.root.querySelector('.kcms-review-note')?.textContent).toContain('Sent back by Rex: Shorter title')
  mounted.unmount()

  mounted = await mountComponent(EntryReviewLog, { review, draft: false })
  await settle()
  expect(mounted.root.querySelector('.kcms-review-note')).toBeNull()
  expect(mounted.root.querySelectorAll('.kcms-review-event')).toHaveLength(2)
})

test('the list shows In review and Sent back beside Draft, and nothing for a draft never sent', async () => {
  const row = (slug: string, review: EntryRow['review'], draft = true): EntryRow => ({ slug, title: slug, draft, review })

  mounted = await mountComponent(WithToaster, { table: { collection: POSTS, rows: [row('waiting', 'review'), row('back', 'sent-back'), row('plain', undefined), row('live', 'review', false)] } })
  await settle()

  const statusOf = (title: string) => [...mounted!.root.querySelectorAll('tr')].find(tr => tr.textContent?.includes(title))?.textContent ?? ''

  expect(statusOf('waiting')).toContain('In review')
  expect(statusOf('waiting')).toContain('Draft')
  expect(statusOf('back')).toContain('Sent back')
  expect(statusOf('plain')).toContain('Draft')
  expect(statusOf('plain')).not.toMatch(/In review|Sent back/)
  expect(statusOf('live')).not.toMatch(/In review|Sent back/)
})
