import type { Mail } from '../src/types'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { scratchDir } from 'kay/test'
import { devFile } from '../src/delivery'
import { createOutbox, outbox } from '../src/outbox'
import { logged } from './fixture/tests/logged'

const mail = (subject: string, extra: Partial<Mail> = {}): Mail => ({ from: 'dev@example.com', to: ['ada@example.com'], cc: [], bcc: [], subject, text: `Text of ${subject}`, headers: {}, attachments: [], ...extra })

async function file(): Promise<string> {
  return join(await scratchDir('outbox-'), '.kay', 'mail-outbox.json')
}

describe('the outbox kept in a file', () => {
  it('is read again by an outbox opened on the file, every field as it was sent', async () => {
    const path = await file()
    const first = createOutbox(path)
    const bytes = new Uint8Array([0, 255, 128, 7])

    await first.send(mail('Plain'))
    await first.send(mail('Rich', { html: '<p>Hi</p>', cc: [{ name: 'Bob, Jr', address: 'bob@example.com' }], replyTo: 'visitor@example.com', headers: { 'X-Test': '1' }, attachments: [{ filename: 'a.bin', content: bytes, contentType: 'application/octet-stream' }, { filename: 'a.txt', content: 'text', cid: 'a' }] }), { to: 'me@example.com', error: 'refused' })

    const second = createOutbox(path)

    expect(second.mails).toEqual(first.mails)
    expect(second.mails[0]!.sentAt).toBeInstanceOf(Date)
    expect(second.find(first.last()!.id)!.attachments[0]!.content).toEqual(Buffer.from(bytes))
    expect(second.to('ADA@example.com').map(each => each.subject)).toEqual(['Plain', 'Rich'])
  })

  it('keeps the last 500 in the file and in memory', async () => {
    const path = await file()
    const first = createOutbox(path)

    for (let each = 0; each < 503; each++)
      await first.send(mail(`Mail ${each}`))

    const second = createOutbox(path)

    expect(second.mails).toHaveLength(500)
    expect(second.mails[0]!.subject).toBe('Mail 3')
    expect(second.last()!.subject).toBe('Mail 502')
  })

  it('empties the file with the outbox, and leaves no half-written file beside it', async () => {
    const path = await file()
    const first = createOutbox(path)

    await first.send(mail('Gone'))
    first.clear()

    expect(await Bun.file(path).json()).toEqual([])
    expect(createOutbox(path).mails).toEqual([])
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('starts empty from a file that is no list of mails, leaving out an entry that is none', async () => {
    const path = await file()

    for (const content of ['', '{', '{"id":"x"}', '"mails"']) {
      await Bun.write(path, content)
      expect(createOutbox(path).mails).toEqual([])
    }

    await Bun.write(path, JSON.stringify([null, 3, { id: 'x' }, { id: 'y', subject: 'Real', text: 'Hi', to: [], cc: [], bcc: [], headers: {}, attachments: [], sentAt: 'yesterday' }, { id: 'w', subject: 'No cc', text: 'Hi', to: ['a@example.com'], headers: {}, attachments: [], sentAt: '2026-01-02T03:04:05.000Z' }, { id: 'z', subject: 'Real', text: 'Hi', to: ['a@example.com'], cc: [], bcc: [], headers: {}, attachments: [], sentAt: '2026-01-02T03:04:05.000Z' }]))

    expect(createOutbox(path).mails.map(each => each.id)).toEqual(['z'])
  })

  it('still tells its watchers and waitFor of each mail', async () => {
    const path = await file()
    const first = createOutbox(path)
    const watched: string[] = []
    const unwatch = first.watch(each => watched.push(each.subject))
    const waiting = first.waitFor('late@example.com')

    await first.send(mail('Late', { to: ['late@example.com'] }))
    unwatch()
    await first.send(mail('Unwatched'))
    expect((await waiting).subject).toBe('Late')
    expect(watched).toEqual(['Late'])
  })

  it('says once that a restart will empty it when the file cannot be written, and sends all the same', async () => {
    const dir = await scratchDir('outbox-')
    // A file where the folder should be.
    const blocker = join(dir, 'blocker')

    await Bun.write(blocker, 'a file')

    const blocked = createOutbox(join(blocker, 'mail-outbox.json'))
    const lines = await logged(async () => {
      await blocked.send(mail('Sent'))
      await blocked.send(mail('Sent again'))
    })

    expect(blocked.mails.map(each => each.subject)).toEqual(['Sent', 'Sent again'])
    expect(lines).toEqual([['warn', expect.stringContaining('a restart of the server empties it')]])
  })

  it('is in memory alone under bun test, which never reads or writes .kay/mail-outbox.json', async () => {
    await outbox.send(mail('Under test'))
    outbox.clear()

    expect(existsSync(devFile('mail-outbox.json'))).toBe(false)
  })
})
