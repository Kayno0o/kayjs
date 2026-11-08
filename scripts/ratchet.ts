import type { Baseline, Entry, Rule } from '../eslint.ratchet'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { BASELINE_FILE, LIMITS, OPTIONS, readBaseline } from '../eslint.ratchet'

// The size ratchet's baseline, `eslint-ratchet.json`: for each file of kay's and the libraries' `src/` past a limit of eslint.ratchet.ts, the largest value it has of each rule it passes. The lint of a file fails past its recorded value, which stops a file from growing; this script fails when a recorded value is above what the file measures now, so a file that shrank takes its smaller value into the baseline in the commit that shrank it.
// `bun scripts/ratchet.ts` checks, `--update` records the values measured now (it refuses to raise a value or add a file already committed, a file split out of another is new; `--init` writes the baseline from scratch, when a limit changes), `--distribution` prints how the files of `src/` spread over each rule, to choose a limit from.
const ROOT = resolve(import.meta.dir, '..')
const RULES = Object.keys(LIMITS) as Rule[]
const MESSAGE_VALUE = {
  'max-lines': /\((\d+)\)\./,
  'max-lines-per-function': /\((\d+)\)\./,
  'complexity': /complexity of (\d+)/,
} satisfies Record<Rule, RegExp>

export async function sources(): Promise<string[]> {
  const files: string[] = []

  for (const pattern of ['src/**/*.ts', 'packages/*/src/**/*.ts']) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: ROOT }))
      files.push(file)
  }

  return files.filter(file => !file.endsWith('.d.ts') && !file.startsWith('src/server/codec/avif-enc')).sort()
}

// The largest value of each rule in a file, read from what the core rules report with a limit of 0 (every file, every function).
export function measure(files: string[]): Map<string, Record<Rule, number>> {
  const linter = new Linter({ configType: 'flat' })
  const rules = Object.fromEntries(RULES.map(rule => [rule, ['error', ...OPTIONS[rule](0)]])) as Record<string, unknown[]>
  const measured = new Map<string, Record<Rule, number>>()

  for (const file of files) {
    const values: Record<Rule, number> = { 'max-lines': 0, 'max-lines-per-function': 0, 'complexity': 0 }
    const messages = linter.verify(readFileSync(join(ROOT, file), 'utf8'), [{ files: ['**/*.ts'], languageOptions: { parser: tsParser }, rules: rules as never }], file)

    for (const { ruleId, message, fatal } of messages) {
      if (fatal)
        throw new Error(`ratchet: ${file}: ${message}`)

      const rule = ruleId as Rule | null
      const value = rule === null || !RULES.includes(rule) ? null : MESSAGE_VALUE[rule].exec(message)?.[1]

      if (rule !== null && value !== undefined && value !== null)
        values[rule] = Math.max(values[rule], Number(value))
    }

    measured.set(file, values)
  }

  return measured
}

function over(values: Record<Rule, number>): Entry {
  return Object.fromEntries(RULES.filter(rule => values[rule] > LIMITS[rule]).map(rule => [rule, values[rule]]))
}

function distribution(measured: Map<string, Record<Rule, number>>): void {
  for (const rule of RULES) {
    const sorted = [...measured.values()].map(values => values[rule]).sort((a, b) => a - b)
    const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
    const past = sorted.filter(value => value > LIMITS[rule]).length

    console.log(`${rule}: ${sorted.length} files, p50 ${at(0.5)}, p75 ${at(0.75)}, p90 ${at(0.9)}, p95 ${at(0.95)}, max ${at(1)}; ${past} past the limit of ${LIMITS[rule]}`)
  }
}

// Whether a file is new since the last commit: code split out of a file past a limit lands in new files, which may enter the baseline at the value they have, as the file it left shrank by as much.
function isNew(file: string): boolean {
  return Bun.spawnSync(['git', 'cat-file', '-e', `HEAD:${file}`], { cwd: ROOT, stderr: 'ignore' }).exitCode !== 0
}

// The baseline a measure gives, and what is wrong between it and the one recorded.
export function reconcile(measured: Map<string, Record<Rule, number>>, recorded: Baseline, added: (file: string) => boolean = () => false): { next: Baseline, problems: string[] } {
  const next: Baseline = {}
  const problems: string[] = []

  for (const [file, values] of measured) {
    const now = over(values)
    const before = recorded[file] ?? {}

    for (const rule of RULES) {
      const value = now[rule]

      if (value === undefined && before[rule] !== undefined)
        problems.push(`${file}: ${rule} is under its limit of ${LIMITS[rule]} now, drop it from the baseline`)
      else if (value !== undefined && before[rule] === undefined)
        problems.push(`${file}: ${rule} is ${value}, past the limit of ${LIMITS[rule]}${added(file) ? ' (new file, recorded by --update)' : ''}`)
      else if (value !== undefined && before[rule] !== undefined && value > before[rule])
        problems.push(`${file}: ${rule} grew from ${before[rule]} to ${value}`)
      else if (value !== undefined && before[rule] !== undefined && value < before[rule])
        problems.push(`${file}: ${rule} shrank from ${before[rule]} to ${value}, record it`)
    }

    if (Object.keys(now).length > 0)
      next[file] = now
  }

  for (const file of Object.keys(recorded)) {
    if (!measured.has(file))
      problems.push(`${file}: no longer a source, drop it from the baseline`)
  }

  return { next, problems }
}

const write = (baseline: Baseline): void => writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`)

if (import.meta.main) {
  const flag = process.argv[2]
  const measured = measure(await sources())

  if (flag === '--distribution') {
    distribution(measured)
  }
  else {
    const recorded = readBaseline()
    const { next, problems } = reconcile(measured, recorded, isNew)
    const growth = problems.filter(problem => problem.includes(' grew ') || (problem.includes(', past the limit of') && !problem.includes('(new file')))

    if (flag === '--update' || flag === '--init') {
      if (flag === '--update' && growth.length > 0) {
        console.error(`ratchet: refusing to raise the baseline, split or simplify instead:\n${growth.join('\n')}`)
        process.exit(1)
      }

      write(next)
      console.log(`ratchet: ${Object.keys(next).length} files in the baseline, ${problems.length} changes recorded`)
    }
    else if (problems.length > 0) {
      console.error(`ratchet: the size baseline (eslint-ratchet.json) is off:\n${problems.join('\n')}\n\nA file past a limit must shrink; one that shrank is recorded with \`bun scripts/ratchet.ts --update\`.`)
      process.exit(1)
    }
  }
}
