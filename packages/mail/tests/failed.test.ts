import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { memoryJobs } from 'kay/server'
import { mailer } from '../src/mailer'

const SINK = Symbol.for('kay.log')
const DAY_MS = 24 * 60 * 60 * 1000

async function refuse(): Promise<never> {
  throw new Error('550 mailbox unavailable')
}

// A mailer whose server refuses everything, its log silenced.
function failing(queue: NonNullable<NonNullable<Parameters<typeof mailer>[0]>['queue']> = {}) {
  const global = globalThis as { [SINK]?: unknown }

  global[SINK] = () => undefined

  return mailer({ from: 'dev@example.com', transport: { send: refuse }, queue: { store: memoryJobs(), attempts: 1, ...queue } })
}

afterEach(() => {
  setSystemTime()
  ;(globalThis as { [SINK]?: unknown })[SINK] = undefined
})

describe('mails given up', () => {
  it('keep who they were for and why they failed, without the body, links, headers and attachments', async () => {
    const mail = failing()

    await mail.enqueue({ to: 'ada@example.com', subject: 'Reset', html: '<a href="https://example.com/reset?token=secret">Reset</a>', text: 'https://example.com/reset?token=secret', unsubscribe: 'https://example.com/unsubscribe?u=1', attachments: [{ filename: 'a.txt', content: 'secret' }] })
    await mail.drain()

    const [kept] = await mail.failed()

    expect(kept!.error).toContain('550 mailbox unavailable')
    expect(kept!.payload.to).toHaveLength(1)
    expect(kept!.payload).toMatchObject({ subject: 'Reset', html: undefined, text: '', headers: {}, attachments: [] })
    expect(JSON.stringify(kept)).not.toContain('secret')
    // A person's erasure still finds it.
    expect(await mail.remove({ recipient: 'ada@example.com' })).toBe(1)
  })

  it('are dropped after 7 days by default, with nothing but a call to the mailer to notice', async () => {
    const mail = failing()

    await mail.enqueue({ to: 'ada@example.com', subject: 'Reset', text: 'Hello' })
    await mail.drain()
    setSystemTime(Date.now() + 6 * DAY_MS)
    expect(await mail.failed()).toHaveLength(1)
    setSystemTime(Date.now() + 2 * DAY_MS)
    expect(await mail.failed()).toHaveLength(0)
  })

  it('follow the app\'s own keepFailed', async () => {
    const mail = failing({ keepFailed: '30d' })

    await mail.enqueue({ to: 'ada@example.com', subject: 'Reset', text: 'Hello' })
    await mail.drain()
    setSystemTime(Date.now() + 20 * DAY_MS)
    expect(await mail.failed()).toHaveLength(1)
  })
})
