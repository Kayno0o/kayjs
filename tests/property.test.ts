import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { findKayFiles } from '../src/build/files'
import { parseKay } from '../src/compiler/parser'
import { formatKay } from '../src/format'

const root = join(import.meta.dir, '..')
const SEED = Number(process.env.KAY_PROPERTY_SEED ?? 464)
const MUTATIONS_PER_FILE = Number(process.env.KAY_PROPERTY_MUTATIONS ?? 4)

// Mulberry32: a small seeded generator, so a failing run replays from its seed.
function random(seed: number): () => number {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state

    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function mutate(source: string, next: () => number): string {
  const lines = source.split('\n')
  const at = Math.floor(next() * lines.length)
  const line = lines[at] ?? ''

  switch (Math.floor(next() * 4)) {
    case 0:
      lines.splice(at, 1)

      break
    case 1:
      lines.splice(at, 0, line)

      break
    case 2:
      lines[at] = next() < 0.5 ? `  ${line}` : line.replace(/^ {1,2}/, '')

      break
    default:
      return lines.slice(0, at).join('\n') + (next() < 0.5 ? '\n' : `\n${line.slice(0, Math.floor(next() * line.length))}`)
  }

  return lines.join('\n')
}

async function corpus(): Promise<{ file: string, source: string }[]> {
  const dirs = [join(root, 'tests/fixtures'), join(root, 'docs/src'), join(root, 'examples')]
  const files = (await Promise.all(dirs.map(async dir => findKayFiles(dir)))).flat().sort()

  return Promise.all(files.map(async file => ({ file, source: await Bun.file(file).text() })))
}

describe('parser and formatter properties', () => {
  it(`parse never throws and keeps diagnostic spans inside the source, and format is idempotent where the input parses (seed ${SEED})`, async () => {
    const files = await corpus()
    const next = random(SEED)
    let parsed = 0

    expect(files.length).toBeGreaterThan(100)

    for (const { file, source } of files) {
      for (let i = 0; i < MUTATIONS_PER_FILE; i++) {
        const input = mutate(source, next)
        const context = `seed ${SEED}, ${file} mutation ${i}:\n${JSON.stringify(input)}`

        let diagnostics

        try {
          diagnostics = parseKay(input).diagnostics
        }
        catch (error) {
          throw new Error(`parse threw on ${context}`, { cause: error })
        }

        for (const d of diagnostics) {
          if (d.start < 0 || d.end < d.start || d.end > input.length)
            throw new Error(`span ${d.start}-${d.end} outside the source (${d.message}) in ${context}`)
        }

        if (diagnostics.length > 0)
          continue

        parsed++
        let once

        try {
          once = formatKay(input)
        }
        catch (error) {
          throw new Error(`format threw on ${context}`, { cause: error })
        }

        if (once.diagnostics.length === 0 && formatKay(once.code).code !== once.code)
          throw new Error(`format is not idempotent on ${context}`)
      }
    }

    expect(parsed).toBeGreaterThan(files.length)
  })
})
