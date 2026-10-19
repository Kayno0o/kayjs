import { describe, expect, it } from 'bun:test'
import { eventBody, eventStream } from '../src/server/event-stream'

// A source blocked on a feed that never speaks, freed only by the signal it was handed.
function quiet(seen: { signal?: AbortSignal, freed: boolean }) {
  return (signal: AbortSignal) => {
    seen.signal = signal

    return (async function* () {
      try {
        await new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
        yield 1
      }
      catch {
        seen.freed = true
      }
    })()
  }
}

describe('an event stream whose source is a function of a signal', () => {
  it('hands the source a signal aborted when the browser goes away, freeing a generator blocked on a quiet feed', async () => {
    const seen: { signal?: AbortSignal, freed: boolean } = { freed: false }
    const reader = eventBody(quiet(seen), () => undefined).getReader()
    const pending = reader.read()

    await Bun.sleep(5)
    expect(seen.signal?.aborted).toBe(false)

    await reader.cancel()
    await Bun.sleep(5)
    expect(seen.signal?.aborted).toBe(true)
    expect(seen.freed).toBe(true)
    expect((await pending).done).toBe(true)
  })

  it('reads the values it gives as an iterable does, ending the stream when it is done', async () => {
    const text = await new Response(eventBody(() => [1, 2], () => undefined)).text()

    expect(text).toContain('event: end')
    expect(text.match(/^data: .+$/gm)).toHaveLength(2)
  })

  it('answers through eventStream() the same way, the source called once reading starts', async () => {
    let calls = 0
    const response = eventStream(() => {
      calls++

      return [1]
    })

    expect(calls).toBe(0)
    await response.text()
    expect(calls).toBe(1)
  })

  it('reports a source function that throws as a failed stream', async () => {
    const reported: unknown[] = []
    const text = await new Response(eventBody((): Iterable<number> => {
      throw new Error('no source')
    }, error => reported.push(error))).text()

    expect(text).toContain('event: error')
    expect((reported[0] as Error).message).toBe('no source')
  })
})
