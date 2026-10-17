import { describe, expect, it } from 'bun:test'
import { parseEvents } from 'kay/library'

// A body sending each chunk as it is, so a line or a `\r\n` can be cut between two reads.
function body(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  return new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift()

      if (chunk === undefined)
        controller.close()
      else
        controller.enqueue(encoder.encode(chunk))
    },
  })
}

async function read(stream: ReadableStream<Uint8Array>, signal = new AbortController().signal): Promise<[string, string][]> {
  const events: [string, string][] = []

  await parseEvents(stream, signal, (event, data) => {
    events.push([event, data])

    return undefined
  })

  return events
}

describe('parseEvents', () => {
  it('reads the event and data of each block, a data line spread over several joined with line breaks', async () => {
    expect(await read(body('event: delta\ndata: {"a":1}\n\ndata: one\ndata: two\n\n'))).toEqual([['delta', '{"a":1}'], ['', 'one\ntwo']])
  })

  it('reads a line or a \\r\\n cut between two chunks, and every line ending', async () => {
    expect(await read(body('da', 'ta: he', 'llo\r', '\n\r', '\ndata: cr\r\rdata: lf\n\n'))).toEqual([['', 'hello'], ['', 'cr'], ['', 'lf']])
  })

  it('skips comments, unknown fields and blocks with nothing in them, and strips one leading space only', async () => {
    expect(await read(body(': keep-alive\n\nid: 7\nretry: 10\ndata:  two spaces\n\ndata\n\n\n\n'))).toEqual([['', ' two spaces'], ['', '']])
  })

  it('reads a character cut between two chunks', async () => {
    const bytes = new TextEncoder().encode('data: é\n\n')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 7))
        controller.enqueue(bytes.slice(7))
        controller.close()
      },
    })

    expect(await read(stream)).toEqual([['', 'é']])
  })

  it('drops a block the body ended in the middle of', async () => {
    expect(await read(body('data: whole\n\ndata: cut'))).toEqual([['', 'whole']])
  })

  it('ends on what an event returns, cancelling the body', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: a\n\nevent: end\ndata:\n\ndata: after\n\n'))
      },
      cancel() {
        cancelled = true
      },
    })
    const seen: string[] = []
    const ended = await parseEvents(stream, new AbortController().signal, (event, data) => {
      seen.push(data)

      return event === 'end' ? 'done' as const : undefined
    })

    expect(ended).toBe('done')
    expect(seen).toEqual(['a', ''])
    expect(cancelled).toBe(true)
  })

  it('stops reading and cancels the body once aborted', async () => {
    let cancelled = false
    const controller = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      start(source) {
        source.enqueue(new TextEncoder().encode('data: first\n\n'))
      },
      cancel() {
        cancelled = true
      },
    })
    const reading = parseEvents(stream, controller.signal, () => {
      controller.abort()

      return undefined
    })

    expect(await reading).toBeUndefined()
    expect(cancelled).toBe(true)
  })
})
