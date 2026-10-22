import type { Command } from './command'
import { readFileSync, statSync } from 'node:fs'
import process from 'node:process'
import { mapPosition } from '../build/sourcemap'
import { transformKay } from '../build/transform'
import { projectRoot } from './command'
import { USAGES } from './usages'

// A `.kay` position in Bun's report, the path absolute.
const KAY_POSITION = /(\/[^\s()]+\.kay):(\d+):(\d+)/g
// The colour codes Bun puts between the parts of a position when it writes to a terminal.
// eslint-disable-next-line no-control-regex
const COLOUR_CODES = /\u001B\[[0-9;]*m/g
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
// A watching run clears the screen itself, which only a terminal does, so it keeps the terminal.
const WATCHING = new Set(['--watch', '--hot'])

// Runs `bun test` in the project with what a kay project's tests need, so nothing but a test script is written: each file in modules of its own (`--isolate`, which gives each file its own test database), `kay/test/preload` loaded, and the `.kay` positions Bun reports pointed at the lines of the source.
export const test: Command = {
  usage: USAGES.test,
  options: {},
  positionals: Infinity,
  // Every argument is `bun test`'s, `--watch`, `--changed` and `--help` included.
  normalize: args => ['--', ...args],
  run: async ({ positionals }) => {
    const root = projectRoot('test')

    if (root === undefined)
      return 1

    const watching = positionals.some(argument => WATCHING.has(argument))
    const color = (process.stdout.isTTY || process.stderr.isTTY) && process.env.NO_COLOR === undefined && process.env.FORCE_COLOR === undefined
    const child = Bun.spawn([process.execPath, 'test', '--isolate', '--preload', 'kay/test/preload', ...positionals], {
      cwd: root,
      stdin: 'inherit',
      stdout: watching ? 'inherit' : 'pipe',
      stderr: watching ? 'inherit' : 'pipe',
      env: { ...process.env, ...color && { FORCE_COLOR: '1' } },
    })
    // The child gets the signal and ends with its report, which is still relayed, so nothing it holds (databases, ports, Chrome) outlives a cancelled run.
    const forward = (signal: NodeJS.Signals) => () => void child.kill(signal)
    // In a terminal Ctrl-C reaches the child through the process group already, so forwarding SIGINT too would send Bun a second one.
    const forwarded = process.stdin.isTTY ? FORWARDED.filter(signal => signal !== 'SIGINT') : FORWARDED
    const handlers = forwarded.map(signal => [signal, forward(signal)] as const)

    for (const [signal, handler] of handlers)
      process.on(signal, handler)

    try {
      if (!watching) {
        const mapper = framesIn(root)

        await Promise.all([relay(child.stdout as ReadableStream<Uint8Array>, process.stdout, mapper), relay(child.stderr as ReadableStream<Uint8Array>, process.stderr, mapper)])
      }

      return await child.exited
    }
    finally {
      for (const [signal, handler] of handlers)
        process.off(signal, handler)
    }
  },
}

// Writes what a closed pipe (`kay test | head`) refuses to nowhere.
function write(to: NodeJS.WriteStream, text: string): void {
  try {
    to.write(text)
  }
  catch {}
}

// Copies a stream line by line, mapping the lines that name a `.kay` position; an unfinished line is written at once unless it names one, so a progress marker does not wait for its newline.
async function relay(from: ReadableStream<Uint8Array>, to: NodeJS.WriteStream, map: (line: string) => string): Promise<void> {
  const decoder = new TextDecoder()
  let pending = ''

  for await (const chunk of from) {
    const text = pending + decoder.decode(chunk, { stream: true })
    const end = text.lastIndexOf('\n') + 1

    pending = text.slice(end)

    if (end > 0)
      write(to, text.slice(0, end).split('\n').map((line, index, lines) => index === lines.length - 1 ? line : map(line)).join('\n'))

    if (pending !== '' && !pending.includes('.kay')) {
      write(to, pending)
      pending = ''
    }
  }

  pending += decoder.decode()

  if (pending !== '')
    write(to, map(pending))
}

// Maps a line's `.kay` positions, from the position in the code the loader compiled the file to.
// A line coloured on a terminal is mapped without its colours, as they split the position.
function framesIn(root: string): (line: string) => string {
  const compiledAt = new Map<string, number>()

  const mapped = (line: string) => line.replace(KAY_POSITION, (found, file: string, row: string, column: string) => {
    try {
      const modified = statSync(file, { throwIfNoEntry: false })?.mtimeMs

      if (modified === undefined)
        return found

      if (compiledAt.get(file) !== modified) {
        transformKay(readFileSync(file, 'utf8'), file, { target: 'ssr', hydratable: true, root })
        compiledAt.set(file, modified)
      }
    }
    catch {
      return found
    }

    return mapPosition(file, row, column) ?? found
  })

  return (line) => {
    const plain = line.replaceAll(COLOUR_CODES, '')

    return plain === line || !plain.includes('.kay:') ? mapped(line) : mapped(plain)
  }
}
