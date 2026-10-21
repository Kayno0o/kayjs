import type { Command } from './command'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { mapPosition } from '../build/sourcemap'
import { transformKay } from '../build/transform'
import { projectRoot } from './command'
import { USAGES } from './usages'

// A `.kay` position in Bun's report, the path absolute, with nothing but colour codes before it.
const KAY_POSITION = /(\/[^\s()]+\.kay):(\d+):(\d+)/g

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

    const color = process.stdout.isTTY && process.env.NO_COLOR === undefined
    const child = Bun.spawn([process.execPath, 'test', '--isolate', '--preload', 'kay/test/preload', ...positionals], {
      cwd: root,
      stdin: 'inherit',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...color && { FORCE_COLOR: '1' } },
    })
    const mapper = framesIn(root)

    await Promise.all([relay(child.stdout, process.stdout, mapper), relay(child.stderr, process.stderr, mapper)])

    return child.exited
  },
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
      to.write(text.slice(0, end).split('\n').map((line, index, lines) => index === lines.length - 1 ? line : map(line)).join('\n'))

    if (pending !== '' && !pending.includes('.kay')) {
      to.write(pending)
      pending = ''
    }
  }

  if (pending !== '')
    to.write(map(pending))
}

// Maps a line's `.kay` positions, from the position in the code the loader compiled the file to, which the test process's own loader compiles the same way.
function framesIn(root: string): (line: string) => string {
  const known = new Set<string>()

  return line => line.replace(KAY_POSITION, (found, file: string, row: string, column: string) => {
    if (!known.has(file)) {
      known.add(file)

      try {
        transformKay(readFileSync(file, 'utf8'), file, { target: 'ssr', hydratable: true, root })
      }
      catch {}
    }

    return mapPosition(file, row, column) ?? found
  })
}
