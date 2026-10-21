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

// Runs the server under a shell ignoring SIGTERM, which is all Bun signals. The server keeps the shell's stdin through fd 3: a POSIX shell (busybox's on Alpine) points a background job's stdin at /dev/null before its redirections run, so `<&0` would read that.
const SUPERVISOR = 'exec 3<&0; trap "" TERM; "$@" <&3 3<&- & child=$!; trap \'kill -KILL $child; exit 0\' HUP; wait $child'

interface SuiteServerOptions<In extends 'ignore' | 'pipe', Err extends 'ignore' | 'pipe'> {
  cwd?: string
  env?: Record<string, string | undefined>
  stdin?: In
  stderr?: Err
}

// Starts a process a whole suite shares, started in a `beforeAll`. Bun SIGTERMs every process still running when a test times out (oven-sh/bun#46373), the suite's with it (one handling SIGTERM exits), and the tests after fail on a refused connection: it runs under a shell that ignores the signal, so a timed-out test fails alone. It ends as it would have, when its stdin closes or it exits on its own; `stopSuiteServer` ends one that does not.
export function spawnSuiteServer<In extends 'ignore' | 'pipe' = 'ignore', Err extends 'ignore' | 'pipe' = 'pipe'>(command: string[], options: SuiteServerOptions<In, Err> = {}): Bun.Subprocess<In, 'pipe', Err> {
  const { stdin = 'ignore', stderr = 'pipe', ...rest } = options

  return Bun.spawn(['sh', '-c', SUPERVISOR, 'sh', ...command], { ...rest, stdin, stdout: 'pipe', stderr })
}

// Stops a process `spawnSuiteServer` started, and waits for it to be gone.
export async function stopSuiteServer(server: Bun.Subprocess<'ignore' | 'pipe', 'pipe', 'ignore' | 'pipe'> | undefined): Promise<void> {
  server?.kill('SIGHUP')
  await server?.exited
}
