import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { scratchDir } from '../../../tests/scratch'
import { fakeAi } from '../src'
import { testing } from './fixture/src/testing'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())
afterEach(() => {
  fakeAi.clear()
  testing.provider = undefined
})

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

it('puts the focus in the field, and nowhere later, when an edit is cancelled while a reply is under way', async () => {
  await using page = await site.open('/replaceable')

  await send(page, 'silent', 'fresh roles=u last=silent files=0')
  await page.click(EDIT)
  await page.click(REGENERATE)
  await page.waitFor('.kai-chat-turn[data-pending]')
  await page.click('.kai-chat-cancel')
  await page.waitFor('.kai-chat-turn[data-editing]', { gone: true })

  expect(await focused(page)).toContain('textarea')

  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })

  expect(await focused(page)).toContain('textarea')
}, 120_000)

const LAST_REPLY = '.kai-chat-turn[data-role=assistant]:last-of-type .kai-chat-text'
const logText = async (page: Page) => page.evaluate(() => document.querySelector('.kai-chat-log')!.textContent ?? '')

it('regenerates a reply that had reasoning and a tool loop: the old reasoning and calls leave the log and are never posted again', async () => {
  await using page = await site.open('/replaceable-tools')

  fakeAi.reply({ reasoning: 'Thinking one', text: 'Checking', calls: [{ name: 'add_note', input: { title: 'first note' } }] })
  fakeAi.reply('Done one')
  await send(page, 'note it', 'Done one')

  expect(await logText(page)).toContain('Thinking one')
  expect(await logText(page)).toContain('first note')

  const before = fakeAi.asked.length

  fakeAi.reply({ reasoning: 'Thinking two', text: 'Checking', calls: [{ name: 'add_note', input: { title: 'second note' } }] })
  fakeAi.reply('Done two')
  await page.click(REGENERATE)
  await page.waitFor(LAST_REPLY, { text: 'Done two' })
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })

  const text = await logText(page)

  expect(text).toContain('Thinking two')
  expect(text).toContain('second note')
  expect(text).not.toContain('Thinking one')
  expect(text).not.toContain('first note')
  expect(text).not.toContain('Done one')
  expect(await page.count('.kai-chat-turn[data-role=assistant]')).toBe(1)

  const posts = fakeAi.asked.slice(before)

  expect(posts.length).toBeGreaterThan(0)
  expect(posts[0]!.messages.map(message => [message.role, message.content])).toEqual([['user', 'note it']])
  expect(JSON.stringify(posts)).not.toContain('first note')
  expect(JSON.stringify(posts)).not.toContain('Thinking one')
  expect(page.errors).toEqual([])
}, 120_000)

// The roles of the log's user turns that hold an edit button.
const editable = async (page: Page) => page.evaluate(() => [...document.querySelectorAll('.kai-chat-turn[data-role=user]')].map(turn => turn.querySelector('button.kai-chat-action') !== null))

it('offers no regenerate while an approval waits or right after its answer, and no edit on the answer', async () => {
  await using page = await site.open('/replaceable-approving')

  fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' } }] })
  fakeAi.reply('May I add it?')
  await page.fill('.kai-chat-form textarea', 'Add milk')
  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('.kai-chat-approval')
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })

  expect(await page.count(REGENERATE)).toBe(0)
  expect(await editable(page)).toEqual([true])

  fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' } }] })
  fakeAi.reply('Added')
  await page.click('.kai-chat-approval button:first-of-type')
  await page.waitFor(LAST_REPLY, { text: 'Added' })
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })

  expect(await page.count('.kai-chat-approval')).toBe(0)
  expect(await page.count(REGENERATE)).toBe(0)
  expect(await editable(page)).toEqual([true, false])

  // The guard lifts with the next message of the visitor's own.
  fakeAi.reply('You are welcome')
  await send(page, 'thanks', 'You are welcome')

  expect(await page.count(REGENERATE)).toBe(1)
  expect(await editable(page)).toEqual([true, false, true])
  expect(page.errors).toEqual([])
}, 120_000)

it('keeps an open edit through an Allow and a Deny, and saves it after', async () => {
  await using page = await site.open('/replaceable-approving')

  fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' } }] })
  fakeAi.reply('May I add it?')
  await page.fill('.kai-chat-form textarea', 'Add milk')
  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('.kai-chat-approval')
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })
  await page.click(`.kai-chat-turn[data-role=user] ${EDIT}`)
  await page.fill('.kai-chat-turn[data-editing] textarea', 'Add bread')

  fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' } }] })
  fakeAi.reply('Added')
  await page.click('.kai-chat-approval button:first-of-type')
  await page.waitFor(LAST_REPLY, { text: 'Added' })
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })

  expect(await page.value('.kai-chat-turn[data-editing] textarea')).toBe('Add bread')

  fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Bread' } }] })
  fakeAi.reply('May I add bread?')
  await page.fill('.kai-chat-form textarea', 'And bread')
  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('.kai-chat-approval')
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })

  fakeAi.reply('Fine')
  await page.click('.kai-chat-approval button:nth-of-type(2)')
  await page.waitFor(LAST_REPLY, { text: 'Fine' })
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })

  expect(await page.count('.kai-chat-turn[data-editing]')).toBe(1)
  expect(await page.value('.kai-chat-turn[data-editing] textarea')).toBe('Add bread')

  fakeAi.reply('Edited')
  await page.click('.kai-chat-save')
  await page.waitFor(LAST_REPLY, { text: 'Edited' })

  expect((await log(page)).map(entry => entry.slice(0, 11))).toEqual(['u:Add bread', 'a:Edited'])
  expect(page.errors).toEqual([])
}, 120_000)

it('says why Enter in the edit field sends nothing while a reply is under way, and stops saying it when the reply ends', async () => {
  await using page = await site.open('/replaceable')

  await send(page, 'silent', 'fresh roles=u last=silent files=0')
  await page.click(EDIT)
  await page.click(REGENERATE)
  await page.waitFor('.kai-chat-turn[data-pending]')

  expect(await page.evaluate(() => document.querySelector<HTMLButtonElement>('.kai-chat-save')!.disabled)).toBe(true)

  await page.click('.kai-chat-turn[data-editing] textarea')
  await page.press('Enter')
  await page.waitFor('.kai-chat-turn[data-editing] .kui-notice', { text: 'Wait for the reply to finish.' })

  expect(await page.count('.kai-chat-turn[data-pending]')).toBe(1)

  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })
  await page.waitFor('.kai-chat-turn[data-editing] .kui-notice', { gone: true })
}, 120_000)

it('cuts the edit button name between graphemes, so an emoji at the cut is not split', async () => {
  await using page = await site.open('/replaceable')

  const message = `${'a'.repeat(39)}😀 tail`

  await send(page, message, `fresh roles=u last=${message} files=0`)

  expect(await page.evaluate(() => document.querySelector('.kai-chat-turn[data-role=user] button.kai-chat-action')!.getAttribute('aria-label'))).toBe(`Edit the message: ${'a'.repeat(39)}…`)

  const family = `${'b'.repeat(38)}👨‍👩‍👧 tail`

  await send(page, family, `fresh roles=uau last=${family} files=0`)

  expect(await page.evaluate(() => [...document.querySelectorAll('.kai-chat-turn[data-role=user] button.kai-chat-action')].at(-1)!.getAttribute('aria-label'))).toBe(`Edit the message: ${'b'.repeat(38)}…`)
}, 120_000)

// A model that says its first words, waits for the test to let it go on, then finishes; an abort ends it where it stands.
function gated(first: string, rest: string) {
  const gate = Promise.withResolvers<void>()
  const state = { asked: 0, aborted: false }

  testing.provider = {
    name: 'gated',
    model: 'm',
    async* stream(_request, signal) {
      state.asked++
      yield { text: first }

      await Promise.race([gate.promise, new Promise(resolve => signal.addEventListener('abort', resolve))])

      if (signal.aborted) {
        state.aborted = true

        return
      }

      yield { text: rest }
      yield { finish: 'stop' }
    },
  }

  return { state, release: gate.resolve }
}

it('resumes a regenerated reply the server kept with outlive, after a reload, and asks the model once', async () => {
  const one = gated('Hel', 'lo there')

  await using page = await site.open('/replaceable-staying')

  await page.fill('.kai-chat-form textarea', 'Go')
  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('[data-pending] .kai-chat-text', { text: 'Hel' })
  one.release()
  await page.waitFor(LAST_REPLY, { text: 'Hello there' })
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })

  const two = gated('Hey', ' again')

  await page.click(REGENERATE)
  await page.waitFor('[data-pending] .kai-chat-text', { text: 'Hey' })
  await page.reload()
  await page.waitFor('[data-pending] .kai-chat-text', { text: 'Hey' })

  // The old reply is gone from the resumed log too.
  expect(await log(page)).toEqual(['u:Go', 'a:Hey'])

  two.release()
  await page.waitFor(LAST_REPLY, { text: 'Hey again' })
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })

  expect(await log(page)).toEqual(['u:Go', 'a:Hey again'])
  expect(one.state.asked).toBe(1)
  expect(two.state.asked).toBe(1)
  expect(two.state.aborted).toBe(false)
  expect(await page.count(REGENERATE)).toBe(1)
  expect(page.errors).toEqual([])
}, 120_000)

it('gives the reasoning of a finished reply a height cap and a place in the tab order', async () => {
  await using page = await site.open('/replaceable-tools')

  fakeAi.reply({ reasoning: 'Long thought. '.repeat(400), text: 'Checking', calls: [{ name: 'add_note', input: { title: 'a note' } }] })
  fakeAi.reply('Done')
  await send(page, 'note it', 'Done')
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })

  const finished = await page.evaluate(() => {
    const details = document.querySelector('.kai-chat-reasoning') as HTMLDetailsElement
    const text = details.querySelector('.kai-chat-reasoning-text') as HTMLElement

    details.open = true

    return { tabindex: text.getAttribute('tabindex'), scrolls: text.scrollHeight > text.clientHeight, overflow: getComputedStyle(text).overflowY }
  })

  expect(finished).toEqual({ tabindex: '0', scrolls: true, overflow: 'auto' })
  expect(page.errors).toEqual([])
}, 120_000)

it('names a call with the label of its action\'s tool', async () => {
  await using page = await site.open('/labelled-tools')

  fakeAi.reply({ text: 'Checking', calls: [{ name: 'home_state' }] })
  fakeAi.reply('Done')
  await send(page, 'how is the home', 'Done')
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })

  expect(await page.evaluate(() => document.querySelector('.kai-chat-calls-summary')?.textContent)).toBe('Read the home')
  expect(page.errors).toEqual([])
}, 120_000)

it('keeps the reasoning open when the visitor opened it while the reply was written, and leaves nothing of the hidden turn to focus', async () => {
  await using page = await site.open('/labelled-tools')

  const gate = Promise.withResolvers<void>()

  testing.provider = {
    name: 'gated',
    model: 'm',
    async* stream() {
      yield { reasoning: 'Pondering' }
      yield { text: 'Almost' }
      await gate.promise
      yield { text: ' done' }
      yield { finish: 'stop' }
    },
  }

  await page.fill('.kai-chat-form textarea', 'think')
  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('.kai-chat-turn[data-pending] .kai-chat-reasoning-text', { text: 'Pondering' })

  expect(await page.evaluate(() => [...document.querySelectorAll('.kai-chat-turn[data-pending] summary, .kai-chat-turn[data-pending] .kai-chat-reasoning-text')].map(element => element.getAttribute('tabindex')))).toEqual(['-1', '-1'])

  await page.click('.kai-chat-turn[data-pending] .kai-chat-reasoning summary')
  gate.resolve()
  await page.waitFor(LAST_REPLY, { text: 'Almost done' })
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })

  expect(await page.evaluate(() => (document.querySelector('.kai-chat-reasoning') as HTMLDetailsElement).open)).toBe(true)
  expect(page.errors).toEqual([])
}, 120_000)

it('leaves the summaries of the calls of the hidden turn out of the tab order, then in it once the turn is written', async () => {
  await using page = await site.open('/labelled-tools')

  const gate = Promise.withResolvers<void>()
  let requests = 0

  testing.provider = {
    name: 'gated',
    model: 'm',
    async* stream() {
      requests++

      if (requests === 1) {
        yield { toolUse: { id: 'one', name: 'home_state', arguments: '{}' } }
        yield { finish: 'stop' }

        return
      }

      yield { text: 'Almost' }
      await gate.promise
      yield { text: ' done' }
      yield { finish: 'stop' }
    },
  }

  await page.fill('.kai-chat-form textarea', 'how is the home')
  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('.kai-chat-turn[data-pending] .kai-chat-calls-summary')

  const pending = await page.evaluate(() => [...document.querySelectorAll('.kai-chat-turn[data-pending] .kai-chat-calls summary')].map(element => element.getAttribute('tabindex')))

  gate.resolve()
  await page.waitFor(LAST_REPLY, { text: 'Almost done' })
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })

  const settled = await page.evaluate(() => [...document.querySelectorAll('.kai-chat-calls summary')].map(element => element.getAttribute('tabindex')))

  expect(pending.length).toBeGreaterThan(0)
  expect(pending.every(tabindex => tabindex === '-1')).toBe(true)
  expect(settled.length).toBeGreaterThan(0)
  expect(settled.every(tabindex => tabindex === null)).toBe(true)
  expect(page.errors).toEqual([])
}, 120_000)
