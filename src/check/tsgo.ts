// The tsgo run `kay check` makes, skipped where its last run was clean and nothing it read has changed since, and what it prints read back as diagnostics.
import type { CheckDiagnostic } from '.'
import type { TsgoDiagnostic } from './diagnose'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { readCacheEntry, writeCacheEntry } from '../build/cache'
import { treeEntries } from '../build/files'
import { offsetAt } from '../compiler/mapping'
import { nativeExe, nativeManifest } from '../compiler/native-typescript'
import { projectPaths } from '../project'

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): (?:error|warning) (TS\d+): (.*)$/
// An error about the whole run, such as a tsconfig that does not exist.
const TSC_GLOBAL_LINE = /^error (TS\d+): (.*)$/

// The options that name a place, which do not change what a file's types are.
const PLACED_OPTIONS = new Set(['rootDirs', 'rootDir', 'paths', 'baseUrl', 'typeRoots', 'outDir', 'declarationDir', 'tsBuildInfoFile', 'configFilePath', 'pathsBasePath'])
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
  const child = Bun.spawn([nativeExe(), '--showConfig', '-p', tsconfig], { cwd: root, stdout: 'pipe', stderr: 'ignore' })
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

  return code === 0 ? output : undefined
}

// What a tsconfig's own options say apart from the places they name, which differ by where the config sits: two configs with the same text here type a file the same way.
// Kept while the config and each config it extends keep their size and time, as tsgo would print the same: a run on a project whose configs did not change spawns nothing.
export async function typingOptions(root: string, tsconfig: string): Promise<string | undefined> {
  const config = resolve(root, tsconfig)
  const stamps = configStamps(config)
  const slot = stamps === undefined ? undefined : { file: join(projectPaths(root).cache, 'config', `${Bun.hash(config).toString(36)}.json`), key: JSON.stringify([(await Bun.file(nativeManifest()).json() as { version: string }).version, stamps]) }
  const kept = slot && await readCacheEntry<string>(slot)

  if (kept !== undefined)
    return kept

  const shown = await resolvedConfig(root, tsconfig)

  if (shown === undefined)
    return undefined

  const { compilerOptions = {} } = JSON.parse(shown) as { compilerOptions?: Record<string, unknown> }
  const options = JSON.stringify(Object.entries(compilerOptions).filter(([name]) => !PLACED_OPTIONS.has(name)).toSorted(([a], [b]) => a < b ? -1 : 1))

  if (slot)
    await writeCacheEntry(slot, options)

  return options
}

// The size and time of a config and of every config it extends, or undefined when one cannot be found or read, which leaves the answer to tsgo.
function configStamps(config: string, seen = new Set<string>()): string[] | undefined {
  if (seen.has(config))
    return []

  seen.add(config)

  try {
    const stat = statSync(config, { throwIfNoEntry: false })

    if (stat === undefined)
      return undefined

    const { size, mtimeMs } = stat
    const { extends: base } = Bun.JSONC.parse(readFileSync(config, 'utf8')) as { extends?: string | string[] }
    const stamps = [`${config}:${size}:${mtimeMs}`]

    for (const name of typeof base === 'string' ? [base] : base ?? []) {
      const found = extendedConfig(dirname(config), name)

      if (found === undefined)
        return undefined

      const inner = configStamps(found, seen)

      if (inner === undefined)
        return undefined

      stamps.push(...inner)
    }

    return stamps
  }
  catch {
    return undefined
  }
}

// The config an `extends` names, a file beside the one extending or one a package ships.
function extendedConfig(dir: string, name: string): string | undefined {
  const candidates = name.startsWith('.') || isAbsolute(name) ? [resolve(dir, name), resolve(dir, `${name}.json`)] : [name, `${name}.json`, `${name}/tsconfig.json`]

  for (const candidate of candidates) {
    try {
      const found = name.startsWith('.') || isAbsolute(name) ? candidate : Bun.resolveSync(candidate, dir)

      if (statSync(found, { throwIfNoEntry: false })?.isFile())
        return found
    }
    catch {}
  }

  return undefined
}

// Runs tsgo incrementally, or not at all when its last run was clean and nothing it read has changed since: tsgo's own incremental mode still parses every file, most of a warm run's time.
// `program` names the run among the several of one project, each keeping its own state.
export async function typecheck(root: string, tsconfig: string, shown: string | undefined, program = ''): Promise<{ output: string, errors: string, code: number }> {
  const { cache, types: shadowDir } = projectPaths(root)
  const state = join(cache, 'check', program)
  const buildInfo = join(state, 'tsbuildinfo')
  const args = ['--noEmit', '--pretty', 'false', '--noUnusedLocals', '-p', tsconfig, '--incremental', '--tsBuildInfoFile', buildInfo]
  // The resolved config lists the root files, so one added or removed changes it as an edited option does.
  const slot = shown === undefined ? undefined : { file: join(state, 'clean.json'), key: JSON.stringify([(await Bun.file(nativeManifest()).json() as { version: string }).version, args, shown]) }
  const last = slot && await readCacheEntry<CleanRun>(slot)

  if (last && await stillClean(last, shadowDir))
    return { output: '', errors: '', code: 0 }

  const generated = await contentHashes(shadowDir)
  const started = Date.now()
  const child = Bun.spawn([nativeExe(), ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
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
  const files = existsSync(dir) ? (await treeEntries(dir)).files : []

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
