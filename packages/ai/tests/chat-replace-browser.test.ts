import { join } from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { scratchDir } from '../../../tests/scratch'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())

type Page = Awaited<ReturnType<typeof site.open>>

const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const REGENERATE = 'button[aria-label="Regenerate the reply"]'
const EDIT = 'button[aria-label^="Edit the message"]'

// The focused element as `tag.first-class|label`, or `body`.
async function focused(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement

    if (element === null || element === document.body)
      return 'body'

    return `${element.tagName.toLowerCase()}.${element.classList[0]}|${element.getAttribute('aria-label') ?? ''}`
  })
}

// The log as a visitor reads it: one entry per turn, `u:` or `a:` then its text.
const log = async (page: Page) => page.evaluate(() => [...document.querySelectorAll('.kai-chat-turn')].map(turn => `${turn.getAttribute('data-role')![0]}:${turn.querySelector('.kai-chat-text')?.textContent?.trim() ?? ''}`))

async function send(page: Page, text: string, answer: string) {
  await page.fill('.kai-chat-form textarea', text)
  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('.kai-chat-turn[data-role=assistant]:last-of-type .kai-chat-text', { text: answer })
}

it('asks again for the last reply: the old one leaves the log, and the action reads that it replaces the reply and the message posted again', async () => {
  await using page = await site.open('/replaceable')

  await send(page, 'one', 'fresh roles=u last=one files=0')
  await send(page, 'two', 'fresh roles=uau last=two files=0')

  expect(await page.count(REGENERATE)).toBe(1)

  await page.click(REGENERATE)
  await page.waitFor('.kai-chat-turn[data-role=assistant]:last-of-type .kai-chat-text', { text: 'regenerate:2 roles=uau last=two files=0' })

  expect(await log(page)).toEqual(['u:one', 'a:fresh roles=u last=one files=0', 'u:two', 'a:regenerate:2 roles=uau last=two files=0'])
  expect(await page.count(REGENERATE)).toBe(1)
  expect(page.errors).toEqual([])
}, 120_000)

it('resends an edited message with every later turn gone, the action reading how many it replaces, and a later send is fresh again', async () => {
  await using page = await site.open('/replaceable')

  await send(page, 'one', 'fresh roles=u last=one files=0')
  await send(page, 'two', 'fresh roles=uau last=two files=0')
  await page.click(`.kai-chat-turn[data-role=user] ${EDIT}`)
  await page.fill('.kai-chat-turn[data-editing] textarea', 'uno')
  await page.click('.kai-chat-save')
  await page.waitFor('.kai-chat-turn[data-role=assistant]:last-of-type .kai-chat-text', { text: 'edit:4 roles=u last=uno files=0' })

  expect(await log(page)).toEqual(['u:uno', 'a:edit:4 roles=u last=uno files=0'])

  await page.click(REGENERATE)
  await page.waitFor('.kai-chat-turn[data-role=assistant]:last-of-type .kai-chat-text', { text: 'regenerate:2 roles=u last=uno files=0' })
  await send(page, 'next', 'fresh roles=uau last=next files=0')

  expect(await log(page)).toEqual(['u:uno', 'a:regenerate:2 roles=u last=uno files=0', 'u:next', 'a:fresh roles=uau last=next files=0'])
  expect(page.errors).toEqual([])
}, 120_000)

it('edits a message in the middle and cancels an edit, leaving the log as it was', async () => {
  await using page = await site.open('/replaceable')

  await send(page, 'one', 'fresh roles=u last=one files=0')
  await send(page, 'two', 'fresh roles=uau last=two files=0')

  const before = await log(page)

  await page.click(`.kai-chat-turn[data-role=user] ${EDIT}`)
  await page.click('.kai-chat-cancel')
  await page.waitFor('.kai-chat-turn[data-editing]', { gone: true })

  expect(await log(page)).toEqual(before)

  await page.evaluate(() => {
    document.querySelectorAll<HTMLButtonElement>('.kai-chat-turn[data-role=user] button[aria-label^="Edit the message"]')[1]!.click()
  })
  await page.fill('.kai-chat-turn[data-editing] textarea', 'deux')
  await page.click('.kai-chat-save')
  await page.waitFor('.kai-chat-turn[data-role=assistant]:last-of-type .kai-chat-text', { text: 'edit:2 roles=uau last=deux files=0' })

  expect(await log(page)).toEqual(['u:one', 'a:fresh roles=u last=one files=0', 'u:deux', 'a:edit:2 roles=uau last=deux files=0'])
}, 120_000)

it('keeps the files of an edited message, and of a message asked again', async () => {
  const dir = await scratchDir('ai-replace-')
  const shot = join(dir, 'shot.png')

  await Bun.write(shot, PNG)

  await using page = await site.open('/replaceable')

  await page.upload('input[type=file]', [shot])
  await page.waitFor('.kai-chat-files .kai-chat-file', { text: 'shot.png' })
  await send(page, 'pic', 'fresh roles=u last=pic files=1')
  await page.click(REGENERATE)
  await page.waitFor('.kai-chat-turn[data-role=assistant]:last-of-type .kai-chat-text', { text: 'regenerate:2 roles=u last=pic files=1' })
  await page.click(`.kai-chat-turn[data-role=user] ${EDIT}`)

  expect(await page.text('.kai-chat-turn[data-editing] .kai-chat-file')).toBe('shot.png')

  await page.fill('.kai-chat-turn[data-editing] textarea', 'pic2')
  await page.click('.kai-chat-save')
  await page.waitFor('.kai-chat-turn[data-role=assistant]:last-of-type .kai-chat-text', { text: 'edit:2 roles=u last=pic2 files=1' })

  expect(await page.text('.kai-chat-turn[data-role=user] .kai-chat-file')).toBe('shot.png')
}, 120_000)

it('offers neither button unless asked for', async () => {
  await using page = await site.open('/replaceless')

  await send(page, 'one', 'fresh roles=u last=one files=0')

  expect(await page.count(REGENERATE)).toBe(0)
  expect(await page.count(EDIT)).toBe(0)
}, 120_000)

it('resumes a regenerated reply after a reload without saying it replaces anything again', async () => {
  await using page = await site.open('/replaceable-kept')

  await send(page, 'hold', 'fresh roles=u last=hold files=0')
  await page.click(REGENERATE)
  await page.waitFor('.kai-chat-turn[data-role=assistant]:last-of-type .kai-chat-text', { text: 'regenerate:2 roles=u last=hold files=0' })
  await page.reload()
  await page.waitFor('.kai-chat-turn[data-role=assistant]:last-of-type .kai-chat-text', { text: 'fresh roles=u last=hold files=0' })

  expect(await log(page)).toEqual(['u:hold', 'a:fresh roles=u last=hold files=0'])
}, 120_000)

it('regenerates the last reply, then edits the first message: no dropped turn is left in the log or posted, and each post says what it replaces', async () => {
  await using page = await site.open('/replaceable')

  await send(page, 'one', 'fresh roles=u last=one files=0')
  await send(page, 'two', 'fresh roles=uau last=two files=0')
  await page.click(REGENERATE)
  await page.waitFor('.kai-chat-turn[data-role=assistant]:last-of-type .kai-chat-text', { text: 'regenerate:2 roles=uau last=two files=0' })
  await page.click(`.kai-chat-turn[data-role=user] ${EDIT}`)
  await page.fill('.kai-chat-turn[data-editing] textarea', 'uno')
  await page.press('Enter')
  await page.waitFor('.kai-chat-turn[data-role=assistant]:last-of-type .kai-chat-text', { text: 'edit:4 roles=u last=uno files=0' })

  expect(await log(page)).toEqual(['u:uno', 'a:edit:4 roles=u last=uno files=0'])
}, 120_000)

it('puts the history back, the edited text in the field, when an edit is stopped before the first word', async () => {
  await using page = await site.open('/replaceable')

  await send(page, 'one', 'fresh roles=u last=one files=0')
  await send(page, 'two', 'fresh roles=uau last=two files=0')

  const before = await log(page)

  await page.click(`.kai-chat-turn[data-role=user] ${EDIT}`)
  await page.fill('.kai-chat-turn[data-editing] textarea', 'silent')
  await page.click('.kai-chat-save')
  await page.waitFor('.kai-chat-turn[data-pending]')
  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })

  expect(await log(page)).toEqual(before)
  expect(await page.value('.kai-chat-form textarea')).toBe('silent')
}, 120_000)

it('puts the reply back when a regenerate is stopped before the first word', async () => {
  await using page = await site.open('/replaceable')

  await send(page, 'silent', 'fresh roles=u last=silent files=0')

  const before = await log(page)

  await page.click(REGENERATE)
  await page.waitFor('.kai-chat-turn[data-pending]')
  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })

  expect(await log(page)).toEqual(before)
  expect(await page.value('.kai-chat-form textarea')).toBe('')
}, 120_000)

it('posts the same request again from Try again after a failed regenerate, and Escape cancels an edit', async () => {
  await using page = await site.open('/replaceable')

  await send(page, 'fail', 'fresh roles=u last=fail files=0')
  await page.click(REGENERATE)
  await page.waitFor('.kui-notice button')
  await page.click('.kui-notice button')
  await page.waitFor('.kai-chat-turn[data-role=assistant]:last-of-type .kai-chat-text', { text: 'regenerate:2 roles=u last=fail files=0' })
  await page.click(`.kai-chat-turn[data-role=user] ${EDIT}`)
  await page.press('Escape')
  await page.waitFor('.kai-chat-turn[data-editing]', { gone: true })

  expect(await log(page)).toEqual(['u:fail', 'a:regenerate:2 roles=u last=fail files=0'])
}, 120_000)

it('names each edit button by the start of its message', async () => {
  await using page = await site.open('/replaceable')

  await send(page, 'one', 'fresh roles=u last=one files=0')
  await send(page, `two ${'x'.repeat(80)}`, `fresh roles=uau last=two ${'x'.repeat(80)} files=0`)

  const names = await page.evaluate(() => [...document.querySelectorAll('.kai-chat-turn[data-role=user] button.kai-chat-action')].map(button => button.getAttribute('aria-label')))

  expect(names).toEqual(['Edit the message: one', `Edit the message: two ${'x'.repeat(36)}…`])
}, 120_000)

it('gives the focus back to the edit button on Cancel, on Escape in the field and on Escape on a button, and to the field on Save', async () => {
  await using page = await site.open('/replaceable')

  await send(page, 'one', 'fresh roles=u last=one files=0')

  const button = 'button.kui-icon-btn|Edit the message: one'

  await page.click(EDIT)
  await page.click('.kai-chat-cancel')
  await page.waitFor('.kai-chat-turn[data-editing]', { gone: true })
  expect(await focused(page)).toBe(button)

  await page.click(EDIT)
  await page.press('Escape')
  await page.waitFor('.kai-chat-turn[data-editing]', { gone: true })
  expect(await focused(page)).toBe(button)

  for (const target of ['.kai-chat-save', '.kai-chat-cancel']) {
    await page.click(EDIT)
    await page.evaluate((selector) => {
      document.querySelector<HTMLElement>(selector)!.focus()
    }, target)
    await page.press('Escape')
    await page.waitFor('.kai-chat-turn[data-editing]', { gone: true })
    expect(await focused(page)).toBe(button)
  }

  await page.click(EDIT)
  await page.fill('.kai-chat-turn[data-editing] textarea', 'uno')
  await page.click('.kai-chat-save')
  await page.waitFor('.kai-chat-turn[data-role=assistant]:last-of-type .kai-chat-text', { text: 'edit:2 roles=u last=uno files=0' })
  expect(await focused(page)).toContain('textarea')
}, 120_000)

it('does not close the launcher panel when Escape cancels an edit', async () => {
  await using page = await site.open('/launching-editable')

  await page.click('.kai-launcher-button')
  await page.waitUntil(() => [...document.querySelectorAll('[data-hydrate=visible]')].every(island => '_$k' in island))
  await send(page, 'one', 'fresh roles=u last=one files=0')
  await page.click(EDIT)
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.kai-chat-save')!.focus()
  })
  await page.press('Escape')
  await page.waitFor('.kai-chat-turn[data-editing]', { gone: true })

  expect(await page.evaluate(() => document.querySelector('.kai-launcher-panel')!.hasAttribute('hidden'))).toBe(false)

  await page.click(EDIT)
  await page.press('Escape')
  await page.press('Escape')
  await page.waitFor('.kai-launcher-panel[hidden]')
}, 120_000)

it('says why Save sent nothing when the message is empty and has no file, and stops saying it once the visitor types', async () => {
  await using page = await site.open('/replaceable')

  await send(page, 'one', 'fresh roles=u last=one files=0')
  await page.click(EDIT)
  await page.fill('.kai-chat-turn[data-editing] textarea', '')
  await page.click('.kai-chat-save')
  await page.waitFor('.kai-chat-turn[data-editing] .kui-notice', { text: 'Write a message to send.' })

  expect(await log(page)).toEqual(['u:', 'a:fresh roles=u last=one files=0'])

  await page.fill('.kai-chat-turn[data-editing] textarea', 'x')
  await page.waitFor('.kai-chat-turn[data-editing] .kui-notice', { gone: true })
}, 120_000)

it('keeps an open edit through a message sent from outside and the reply to it, and saves it after', async () => {
  await using page = await site.open('/replaceable')

  await send(page, 'one', 'fresh roles=u last=one files=0')
  await send(page, 'two', 'fresh roles=uau last=two files=0')
  await page.click(`.kai-chat-turn[data-role=user] ${EDIT}`)
  await page.fill('.kai-chat-turn[data-editing] textarea', 'uno')
  await page.evaluate(() => {
    document.querySelector('.kai-chat')!.dispatchEvent(new CustomEvent('kai-chat-send', { detail: 'three' }))
  })
  await page.waitFor('.kai-chat-turn[data-role=assistant]:last-of-type .kai-chat-text', { text: 'fresh roles=uauau last=three files=0' })

  expect(await page.value('.kai-chat-turn[data-editing] textarea')).toBe('uno')

  await page.click('.kai-chat-save')
  await page.waitFor('.kai-chat-turn[data-role=assistant]:last-of-type .kai-chat-text', { text: 'edit:6 roles=u last=uno files=0' })
}, 120_000)

it('draws the icons a ChatLauncher is given for the regenerate and edit buttons', async () => {
  await using page = await site.open('/launching-editable')

  await page.click('.kai-launcher-button')
  await page.waitUntil(() => [...document.querySelectorAll('[data-hydrate=visible]')].every(island => '_$k' in island))
  await send(page, 'one', 'fresh roles=u last=one files=0')

  expect(await page.text(`${EDIT} .mine-edit`)).toBe('E')
  expect(await page.text(`${REGENERATE} .mine-regenerate`)).toBe('R')
}, 120_000)
