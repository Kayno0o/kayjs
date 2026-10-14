import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

const root = join(import.meta.dir, '..')

// What kay's browser code may not call, as Bun ships it as written: each needs a browser past the floor llms/islands.md states (Chrome and Edge 98, Firefox 104, Safari 16.4).
const PAST_THE_FLOOR: [RegExp, string][] = [
  [/\.(?:toSorted|toReversed|toSpliced)\(/, 'change-array-by-copy (Chrome 110, Firefox 115)'],
  [/\b(?:Object|Map)\.groupBy\(/, 'groupBy (Chrome 117, Safari 17.4)'],
  [/\bPromise\.(?:withResolvers|try)\(/, 'Promise.withResolvers and Promise.try (Chrome 119, Safari 17.4)'],
  [/\bArray\.fromAsync\(/, 'Array.fromAsync (Chrome 121)'],
  [/\.(?:union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/, 'Set methods (Chrome 122, Firefox 127, Safari 17)'],
  [/\.(?:values|keys|entries)\(\)\.(?:map|filter|take|drop|flatMap|reduce|toArray|forEach|some|every|find)\(/, 'iterator helpers (Firefox 131, Safari 18.4)'],
  [/\b(?:Iterator\.from|RegExp\.escape|Error\.isError|Math\.sumPrecise)\(/, 'ES2025 statics (Chrome 122 on, Safari 18.4 on)'],
  [/\.(?:isWellFormed|toWellFormed)\(/, 'well-formed strings (Chrome 111, Firefox 119)'],
  [/\bURL\.(?:canParse|parse)\(/, 'URL.canParse (Chrome 120, Safari 17) and URL.parse (Chrome 126, Safari 18)'],
]

// A selector kay's own runtime may only query behind a check, as one a browser lacks throws; kayjs-ui states the Popover API as its floor.
const UNGUARDED_POPOVER = /querySelector(?:All)?\(':popover-open'/
const POPOVER_CHECK = /'popover' in /

// The code an island ships: kay's runtime, its server-only and dev-only modules left out, and kayjs-ui's components.
async function browserFiles(): Promise<string[]> {
  const runtime = await Array.fromAsync(new Bun.Glob('src/runtime/*.ts').scan({ cwd: root }))
  const ui = await Array.fromAsync(new Bun.Glob('packages/ui/src/**/*.{ts,kay}').scan({ cwd: root }))

  return [...runtime.filter(path => !path.endsWith('.server.ts') && !path.includes('/dev-')), ...ui.filter(path => !path.endsWith('.test.ts'))]
}

describe('the browsers kay supports', () => {
  it('ships no browser code past the stated floor, which Bun would not lower', async () => {
    const found: string[] = []

    for (const path of await browserFiles()) {
      const lines = (await Bun.file(join(root, path)).text()).split('\n')

      for (const [index, line] of lines.entries()) {
        for (const [pattern, feature] of PAST_THE_FLOOR) {
          if (pattern.test(line))
            found.push(`${path}:${index + 1} uses ${feature}`)
        }

        if (path.startsWith('src/') && UNGUARDED_POPOVER.test(line) && !POPOVER_CHECK.test(line))
          found.push(`${path}:${index + 1} queries :popover-open unguarded (Chrome 114, Firefox 125, Safari 17)`)
      }
    }

    expect(found).toEqual([])
  })
})
