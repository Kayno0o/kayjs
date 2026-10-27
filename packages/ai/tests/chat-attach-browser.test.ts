import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { scratchDir } from '../../../tests/scratch'
import { fakeAi } from '../src'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())
afterEach(() => fakeAi.clear())

const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const FILE = 'input[type=file]'

it('attaches a file in the chat, shows it as a chip, posts it with the message and shows it in the turn', async () => {
  const dir = await scratchDir('ai-attach-')
  const shot = join(dir, 'shot.png')

  await Bun.write(shot, PNG)

  await using page = await site.open('/attacher')

  expect(await page.count('button[aria-label="Attach a file"]')).toBe(1)

  await page.upload(FILE, [shot])
  await page.waitFor('.kai-chat-files .kai-chat-file', { text: 'shot.png' })
  await page.click('.kai-chat-files button[aria-label="Remove shot.png"]')
  await page.waitFor('.kai-chat-files', { gone: true })

  await page.upload(FILE, [shot])
  await page.waitFor('.kai-chat-files .kai-chat-file', { text: 'shot.png' })
  await page.fill('.kai-chat-form textarea', 'What is this?')
  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('.kai-chat-turn[data-role=assistant]', { text: 'Fake reply to: What is this?' })

  expect(await page.text('.kai-chat-turn[data-role=user] .kai-chat-file')).toBe('shot.png')
  expect(fakeAi.last()!.messages[0]!.attachments!.map(media => [media.name, media.type])).toEqual([['shot.png', 'image/png']])
  expect(page.errors).toEqual([])
}, 120_000)

it('leaves out a file of a type the chat does not accept and says so', async () => {
  const dir = await scratchDir('ai-attach-')
  const note = join(dir, 'note.txt')

  await Bun.write(note, 'hello')

  await using page = await site.open('/attacher')

  await page.upload(FILE, [note])
  await page.waitFor('.kui-notice', { text: 'Only images and PDFs can be attached.' })

  expect(await page.count('.kai-chat-files')).toBe(0)
}, 120_000)

it('takes a file dropped on the attach button once, and says why for one it leaves out', async () => {
  await using page = await site.open('/attacher')

  await page.evaluate(() => {
    const files = new DataTransfer()

    files.items.add(new File(['x'], 'a.png', { type: 'image/png' }))
    files.items.add(new File(['x'], 'note.txt', { type: 'text/plain' }))
    document.querySelector('.kai-chat-form button[aria-label="Attach a file"]')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: files }))
  })
  await page.waitFor('.kai-chat-files .kai-chat-file', { text: 'a.png' })
  await page.waitFor('.kui-notice', { text: 'Only images and PDFs can be attached.' })

  expect(await page.count('.kai-chat-files .kai-chat-file')).toBe(1)
  expect(await page.count('.kui-notice')).toBe(1)
  expect(page.errors).toEqual([])
}, 120_000)
