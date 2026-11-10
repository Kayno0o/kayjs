import type { Command } from './command'
import { readFileSync, statSync } from 'node:fs'
import process from 'node:process'
import { mapPosition } from '../build/sourcemap'
import { transformKay } from '../build/transform'
import { asksForHelp, printDocument, projectRoot, takeFormat } from './command'

// A `.kay` position in Bun's report, the path absolute.
const KAY_POSITION = /(\/[^\s()]+\.kay):(\d+):(\d+)/g
// The colour codes Bun puts between the parts of a position when it writes to a terminal.
// eslint-disable-next-line no-control-regex
const COLOUR_CODES = /\u001B\[[0-9;]*m/g
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
// A watching run clears the screen itself, which only a terminal does, so it keeps the terminal.
const WATCHING = new Set(['--watch', '--hot'])

const HELP = `kay test runs bun test in the project with --isolate (each file gets its own test database) and kay/test/preload, and points the .kay positions Bun reports at the lines of the source; every argument is bun test's and its exit code is the answer.
--format json prints one JSON document on stdout, { ok, exitCode, pass, fail, skip, tests, files }, and the report goes to stderr.

bun test's own help follows.
`
// The totals of Bun's summary: `3 pass`, `1 fail`, `Ran 4 tests across 2 files.`
const SUMMARY_COUNT = /^\s*(\d+) (pass|fail|skip|todo)\s*$/gm
const SUMMARY_RAN = /Ran (\d+) tests? across (\d+) files?/

// Runs `bun test` in the project with what a kay project's tests need, so nothing but a test script is written: each file in modules of its own (`--isolate`, which gives each file its own test database), `kay/test/preload` loaded, and the `.kay` positions Bun reports pointed at the lines of the source.
export const test: Command = {
  usage: 'test [bun test arguments]...',
  options: { format: { type: 'string' } },
  positionals: Infinity,
  // Every argument is `bun test`'s, `--watch`, `--changed` and `--help` included, but `--format json|text`.
  normalize: takeFormat,
  run: async ({ values, positionals }) => {
    const json = values.format === 'json'
    const root = projectRoot('test', '.', json ? 'json' : 'text')

    if (root === undefined)
      return 1

    if (asksForHelp(positionals)) {
      console.log(HELP)

      return Bun.spawn([process.execPath, 'test', '--help'], { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] }).exited
    }

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

        // Under --format json stdout holds the document alone, so the report goes to stderr.
        const report = json ? process.stderr : process.stdout
        const seen: string[] = []
        const tee = (line: string) => {
          seen.push(line)

          return mapper(line)
        }

        await Promise.all([relay(child.stdout as ReadableStream<Uint8Array>, report, tee), relay(child.stderr as ReadableStream<Uint8Array>, process.stderr, tee)])

        if (json) {
          const exitCode = await child.exited

          printDocument(summaryOf(seen.join('\n'), exitCode))

          return exitCode
        }
      }

      return await child.exited
    }
    finally {
      for (const [signal, handler] of handlers)
        process.off(signal, handler)
    }
  },
}

// The totals of a finished run, read from Bun's summary lines.
function summaryOf(report: string, exitCode: number) {
  const counts = { pass: 0, fail: 0, skip: 0, todo: 0 }

  const plain = report.replaceAll(COLOUR_CODES, '')

  for (const [, count, kind] of plain.matchAll(SUMMARY_COUNT))
    counts[kind as keyof typeof counts] = Number(count)

  const [, tests, files] = SUMMARY_RAN.exec(plain) ?? []

  return { ok: exitCode === 0, exitCode, ...counts, tests: Number(tests ?? 0), files: Number(files ?? 0) }
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
