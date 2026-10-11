// The tsgo run `kay check` makes, skipped where its last run was clean and nothing it read has changed since, and what it prints read back as diagnostics.
import type { CheckDiagnostic } from '.'
import type { TsgoDiagnostic } from './diagnose'
import { existsSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { readCacheEntry, writeCacheEntry } from '../build/cache'
import { offsetAt } from '../compiler/mapping'
import { projectPaths } from '../project'

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): (?:error|warning) (TS\d+): (.*)$/
// An error about the whole run, such as a tsconfig that does not exist.
const TSC_GLOBAL_LINE = /^error (TS\d+): (.*)$/
const TSGO_PACKAGE = fileURLToPath(import.meta.resolve('@typescript/native-preview/package.json'))

export const TSGO = join(dirname(TSGO_PACKAGE), 'bin', 'tsgo')
// A filesystem stamps writes off a coarse clock, milliseconds behind on Linux and up to a second on some, so a file written that close before a run counts as written after it.
const CLOCK_SLACK = 1000

// What tsgo printed, one diagnostic a line, the lines after one that start no other added to its message.
export function parseTscOutput(output: string, config: string, root: string): CheckDiagnostic[] {
  const diagnostics: CheckDiagnostic[] = []

  for (const line of output.split('\n')) {
    const match = TSC_LINE.exec(line)

    if (match) {
      diagnostics.push({ file: resolve(root, match[1]!), line: Number(match[2]), column: Number(match[3]), code: match[4], message: match[5]! })

      continue
    }

    const global = TSC_GLOBAL_LINE.exec(line)

    if (global) {
      diagnostics.push({ file: config, line: 1, column: 1, code: global[1], message: global[2]! })

      continue
    }

    const last = diagnostics.at(-1)

    if (last && line.trim() !== '')
      last.message += `\n${line}`
  }

  return diagnostics
}

// The project's tsconfig as tsgo resolves it, its extends, options and root files, or undefined when tsgo cannot read it.
export async function resolvedConfig(root: string, tsconfig: string): Promise<string | undefined> {
  const child = Bun.spawn([process.execPath, TSGO, '--showConfig', '-p', tsconfig], { cwd: root, stdout: 'pipe', stderr: 'ignore' })
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

  return code === 0 ? output : undefined
}

// Runs tsgo incrementally, or not at all when its last run was clean and nothing it read has changed since: tsgo's own incremental mode still parses every file, most of a warm run's time.
export async function typecheck(root: string, tsconfig: string, shown: string | undefined): Promise<{ output: string, errors: string, code: number }> {
  const { cache, types: shadowDir } = projectPaths(root)
  const state = join(cache, 'check')
  const buildInfo = join(state, 'tsbuildinfo')
  const args = ['--noEmit', '--pretty', 'false', '--noUnusedLocals', '-p', tsconfig, '--incremental', '--tsBuildInfoFile', buildInfo]
  // The resolved config lists the root files, so one added or removed changes it as an edited option does.
  const slot = shown === undefined ? undefined : { file: join(state, 'clean.json'), key: JSON.stringify([(await Bun.file(TSGO_PACKAGE).json() as { version: string }).version, args, shown]) }
  const last = slot && await readCacheEntry<CleanRun>(slot)

  if (last && await stillClean(last, shadowDir))
    return { output: '', errors: '', code: 0 }

  const generated = await contentHashes(shadowDir)
  const started = Date.now()
  const child = Bun.spawn([process.execPath, TSGO, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const read = slot && code === 0 && output === '' && errors === '' ? await filesRead(buildInfo) : undefined

  if (slot && read)
    await writeCacheEntry(slot, { started, ...read, files: read.files.filter(file => !Object.hasOwn(generated, file)), generated } satisfies CleanRun)

  return { output, errors, code }
}

interface CleanRun {
  started: number
  // Every file the run read, packages' own included, by its times, and the package.json files it looked for and did not find.
  files: string[]
  missing: string[]
  // What kay wrote to the shadow tree just before the run, by content: it rewrites a file there on every check that changes it, too close to the run for its times to tell.
  generated: Record<string, string>
}

// What a run read, off its build info: TypeScript's own libraries are named bare there, and change only with tsgo's version.
async function filesRead(buildInfo: string): Promise<Pick<CleanRun, 'files' | 'missing'> | undefined> {
  try {
    const info = await Bun.file(buildInfo).json() as { fileNames: string[], packageJsons?: string[], missingPackageJsons?: string[] }
    const dir = dirname(buildInfo)

    return { files: [...info.fileNames.filter(name => name.includes('/')), ...info.packageJsons ?? []].map(name => resolve(dir, name)), missing: (info.missingPackageJsons ?? []).map(name => resolve(dir, name)) }
  }
  catch {
    return undefined
  }
}

async function contentHashes(dir: string): Promise<Record<string, string>> {
  const files = existsSync(dir) ? (await readdir(dir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)) : []

  return Object.fromEntries(await Promise.all(files.map(async file => [file, Bun.hash(await Bun.file(file).bytes()).toString(36)] as const)))
}

// A file's change time moves when it is written, replaced or linked anew, which a package manager hardlinking an older file into node_modules does while keeping its modification time.
async function stillClean(run: CleanRun, shadowDir: string): Promise<boolean> {
  const unchanged = run.files.every((file) => {
    const stats = statSync(file, { throwIfNoEntry: false })

    return stats !== undefined && Math.max(stats.mtimeMs, stats.ctimeMs) < run.started - CLOCK_SLACK
  })

  if (!unchanged || run.missing.some(file => existsSync(file)))
    return false

  const hashes = Object.entries(await contentHashes(shadowDir))

  return hashes.length === Object.keys(run.generated).length && hashes.every(([file, hash]) => run.generated[file] === hash)
}

// What tsgo printed, at its offset in the file it read.
export function tsgoDiagnostic(diagnostic: CheckDiagnostic, text: string): TsgoDiagnostic {
  const start = offsetAt(text, diagnostic)

  return { code: tsgoCode(diagnostic), message: diagnostic.message, start, end: start }
}

// `TS2322` as tsgo numbers it.
export function tsgoCode(diagnostic: CheckDiagnostic): number | undefined {
  return diagnostic.code === undefined ? undefined : Number(diagnostic.code.slice(2))
}
