// A test server started with piped output must have both pipes read for as long as it runs: nobody reading one lets it fill at 64 KB, after which the server blocks on its next write and every request hangs.

// What a spawned child exposes of its output: a stream for each pipe, none for an inherited or ignored one.
interface Piped {
  stdout: ReadableStream<Uint8Array> | number | undefined
  stderr: ReadableStream<Uint8Array> | number | undefined
}

const LISTENING = /listening (\d+)/

async function discard(stream: ReadableStream<Uint8Array>): Promise<void> {
  try {
    for await (const chunk of stream)
      void chunk
  }
  catch {}
}

// Reads and drops what a child prints from now on, on every pipe it has.
export function drainOutput(child: Piped): void {
  if (child.stdout instanceof ReadableStream)
    void discard(child.stdout)

  if (child.stderr instanceof ReadableStream)
    void discard(child.stderr)
}

// Waits for the line a server prints with its port, `pattern` capturing it (`listening 3000` unless given), then drains the rest of its output. A child that exits first fails with what it printed.
export async function listeningPort(child: Piped & { stdout: ReadableStream<Uint8Array> }, name = 'the server', pattern = LISTENING): Promise<string> {
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ''

  for (let match = pattern.exec(output); !match; match = pattern.exec(output)) {
    const { value, done } = await reader.read()

    if (done) {
      const errors = child.stderr instanceof ReadableStream ? await new Response(child.stderr).text() : ''

      throw new Error(`${name} exited without listening: ${output}${errors}`)
    }

    output += decoder.decode(value, { stream: true })
  }

  reader.releaseLock()
  drainOutput(child)

  return pattern.exec(output)![1]!
}
