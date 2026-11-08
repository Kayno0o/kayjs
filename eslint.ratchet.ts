import type { TypedFlatConfigItem } from '@kaynooo/eslint'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

// The size ratchet of kay's own sources (`src/` of kay and of each library): a file, a function or a complexity past these limits is a lint error, except where `eslint-ratchet.json` records the value the file had when the limit was set.
// The limits sit near the 97th percentile of the files of kay's and the libraries' `src/` when they were chosen (`bun scripts/ratchet.ts --distribution` prints it), so most files are under them and the ones over them are the ones worth splitting.
export const LIMITS = {
  'max-lines': 600,
  'max-lines-per-function': 150,
  'complexity': 40,
} as const

export type Rule = keyof typeof LIMITS
export type Entry = Partial<Record<Rule, number>>
export type Baseline = Record<string, Entry>

export const BASELINE_FILE = resolve(import.meta.dirname, 'eslint-ratchet.json')

// What each rule counts: lines of code, not blank lines or comments, as fta's code lines do.
export const OPTIONS: Record<Rule, (max: number) => unknown[]> = {
  'max-lines': max => [{ max, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': max => [{ max, skipBlankLines: true, skipComments: true, IIFEs: true }],
  'complexity': max => [max],
}

export function readBaseline(): Baseline {
  return existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Baseline : {}
}

// The rules at the limits for every file, with a file of the baseline allowed the value it has now and no more. Paths of the baseline are from the repo root; `dir` is the folder of the eslint config using the result.
export function ratchetRules(dir: string, baseline: Baseline = readBaseline()): TypedFlatConfigItem[] {
  const prefix = relative(import.meta.dirname, resolve(dir))
  const own = Object.entries(baseline).filter(([file]) => prefix === '' || file.startsWith(`${prefix}/`))
  const rules = (limits: Entry): NonNullable<TypedFlatConfigItem['rules']> => Object.fromEntries(
    Object.entries(limits).map(([rule, max]) => [rule, ['error', ...OPTIONS[rule as Rule](max)]]),
  )

  return [
    { files: ['src/**/*.ts'], rules: rules(LIMITS) },
    ...own.map(([file, entry]): TypedFlatConfigItem => ({ files: [prefix === '' ? file : file.slice(prefix.length + 1)], rules: rules(entry) })),
  ]
}
