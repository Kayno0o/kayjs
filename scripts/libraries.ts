// `bun scripts/libraries.ts [--jobs=<n>] [<library>...]`: each library's `check` then `test`, as CI runs them, two libraries at a time: each suite runs six test workers, and three at once ran every one 2.4 times slower than alone on the runner's six cores, timing out the first test of a file, which pays its cold build.
// Each library's output is held until it ends and printed whole, a failed one's after all the others, so its failed tests read as bun prints them and end the step's log.
import { closeSync, openSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import process from 'node:process'

const ROOT = join(import.meta.dir, '..')
const JOBS = 2
const LIMIT_MS = 300_000
const GRACE_MS = 30_000
// The two suites of about 80 s alone in CI, started first so the shorter ones fill in after them.
const SLOWEST = ['cms', 'ui']
const JOBS_FLAG = /^--jobs=(\d+)$/

export interface LibraryRun {
  jobs?: number
  // A library's check and test share it: the one running when it passes is interrupted, so bun names its files still running, then killed after the grace.
  limitMs?: number
  graceMs?: number
  write?: (text: string) => void | Promise<unknown>
}

export interface LibraryResult { folder: string, passed: boolean }

type Outcome = 'passed' | 'failed' | 'interrupted'

// The libraries under packages/, the slowest first, then by name.
export async function libraryFolders(root: string): Promise<string[]> {
  const names: string[] = []

  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (entry.isDirectory() && await Bun.file(join(root, 'packages', entry.name, 'package.json')).exists())
      names.push(entry.name)
  }

  const rank = (name: string) => SLOWEST.includes(name) ? SLOWEST.indexOf(name) : SLOWEST.length

  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map(name => join(root, 'packages', name))
}

// One package script of the library, its output appended to `fd`.
async function script(folder: string, name: string, fd: number, limitMs: number, graceMs: number): Promise<Outcome> {
  const child = Bun.spawn([process.execPath, 'run', name], { cwd: folder, stdin: 'ignore', stdout: fd, stderr: fd })
  let interrupted = false
  const timers = [setTimeout(() => {
    interrupted = true
    child.kill('SIGINT')
  }, limitMs), setTimeout(() => child.kill('SIGKILL'), limitMs + graceMs)]

  const code = await child.exited

  for (const timer of timers)
    clearTimeout(timer)

  if (interrupted)
    return 'interrupted'

  return code === 0 ? 'passed' : 'failed'
}

// One library's `check`, then its `test` once the check passed, into a log file of its own, answering the line closing its output.
async function library(folder: string, log: string, options: LibraryRun): Promise<{ passed: boolean, summary: string }> {
  const started = performance.now()
  const limitMs = options.limitMs ?? LIMIT_MS
  let fd: number | undefined

  try {
    fd = openSync(log, 'w')

    for (const name of ['check', 'test']) {
      const outcome = await script(folder, name, fd, Math.max(0, started + limitMs - performance.now()), options.graceMs ?? GRACE_MS)

      if (outcome === 'interrupted')
        return { passed: false, summary: `${name} interrupted after ${limitMs / 1000} s` }

      if (outcome === 'failed')
        return { passed: false, summary: `${name} failed after ${Math.round((performance.now() - started) / 1000)} s` }
    }

    return { passed: true, summary: `passed in ${Math.round((performance.now() - started) / 1000)} s` }
  }
  catch (error) {
    // A library that could not run fails alone, so the others still end before their logs are removed.
    return { passed: false, summary: `could not run: ${error instanceof Error ? error.message : String(error)}` }
  }
  finally {
    if (fd !== undefined)
      closeSync(fd)
  }
}

// A library's output, empty when its log could not be opened.
async function logText(log: string): Promise<string> {
  try {
    return await Bun.file(log).text()
  }
  catch {
    return ''
  }
}

// Every library through `check` and `test`, `jobs` at a time, each one's output written whole once it ends, the failed ones' last. Answers each library's result in the order given, once every write has landed.
export async function runLibraries(folders: string[], options: LibraryRun = {}): Promise<LibraryResult[]> {
  // Bun.write waits until the pipe took every byte, where process.stdout.write followed by process.exit cut CI's log at a 32 KiB boundary.
  const write = options.write ?? (async (text: string) => Bun.write(Bun.stdout, text))
  const logs = await mkdtemp(join(tmpdir(), 'kay-libraries-'))
  const results: LibraryResult[] = []
  const failed: string[] = []
  let next = 0
  // One write at a time, in the order the libraries ended, so two outputs never interleave.
  let written = Promise.resolve()
  const after = async (previous: Promise<void>, text: string) => {
    await previous
    await write(text)
  }
  const print = (text: string) => {
    written = after(written, text)
  }

  async function worker() {
    while (next < folders.length) {
      const index = next++
      const folder = folders[index]!
      const log = join(logs, `${index}.log`)
      const { passed, summary } = await library(folder, log, options)
      const name = relative(process.cwd(), folder)
      const text = `${name}/\n${await logText(log)}${name}: ${summary}\n`

      results[index] = { folder, passed }

      if (passed)
        print(text)
      else
        failed.push(text)
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.jobs ?? JOBS, folders.length)) }, worker))
  }
  finally {
    await rm(logs, { recursive: true, force: true })
  }

  for (const text of failed)
    print(text)

  await written

  return results
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const jobs = args.map(arg => JOBS_FLAG.exec(arg)?.[1]).find(value => value !== undefined)
  const named = args.filter(arg => !arg.startsWith('--'))
  const folders = named.length > 0 ? named.map(name => join(ROOT, 'packages', name)) : await libraryFolders(ROOT)
  const failures = (await runLibraries(folders, { jobs: jobs === undefined ? JOBS : Number(jobs) })).filter(result => !result.passed)

  if (failures.length > 0) {
    console.error(`failed: ${failures.map(result => relative(ROOT, result.folder)).join(', ')}`)
    process.exitCode = 1
  }
}
