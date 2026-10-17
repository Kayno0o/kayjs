// A `\r` ending a chunk may be half of a `\r\n`, so it waits for the next one.
const LINE_BREAK = /\r\n|\r(?!$)|\n/
// The one space a field's value may start with, which is not part of it.
const LEADING_SPACE = /^ /

// Reads `text/event-stream` blocks, a `data` field over several lines joined with line breaks, comments skipped; resolves with what an event returned to end the stream, or undefined when the body ran out first.
// Aborting cancels the body, which stops the source on the server even where fetch would leave the body open.
export async function parseEvents<End>(body: ReadableStream<Uint8Array>, signal: AbortSignal, onEvent: (event: string, data: string) => End | undefined): Promise<End | undefined> {
  const reader = body.getReader()
  const cancel = async () => {
    try {
      await reader.cancel()
    }
    catch {}
  }

  const onAbort = () => void cancel()

  // One listener per run, removed as it ends, as every reconnect of a stream reads under the same signal.
  signal.addEventListener('abort', onAbort, { once: true })
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let data: string[] = []

  try {
    for (;;) {
      const { done, value } = await reader.read()

      if (done)
        return undefined

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split(LINE_BREAK)

      buffer = lines.pop() ?? ''

      for (const line of lines) {
        // A listener starting another run aborts this one, whose chunk holds events of its own still.
        if (signal.aborted)
          return undefined

        if (line === '') {
          const ended = data.length > 0 || event !== '' ? onEvent(event, data.join('\n')) : undefined

          event = ''
          data = []

          if (ended !== undefined) {
            await reader.cancel()

            return ended
          }

          continue
        }

        if (line.startsWith(':'))
          continue

        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        const text = colon === -1 ? '' : line.slice(colon + 1).replace(LEADING_SPACE, '')

        if (field === 'event')
          event = text
        else if (field === 'data')
          data.push(text)
      }
    }
  }
  finally {
    signal.removeEventListener('abort', onAbort)
  }
}
