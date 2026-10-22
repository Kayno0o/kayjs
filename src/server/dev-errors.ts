import type { Elysia } from 'elysia'
import type { FileDiagnostic } from '../build/transform'
import type { TypeProblem } from '../dev/refuse'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { outputDir, underKayDev } from '../build/assets'
import { describeThrown } from '../build/sourcemap'
import { codeFrame } from '../compiler/frame'
import { offsetAt, positionAt } from '../compiler/mapping'
import { alive } from './lifecycle'
import { pathOf, statusOf } from './log'
import { firstOwnFrame } from './overlay'

// One error a `kay dev` server met, as `.kay/dev/errors.json` lists it for a reader without a browser, such as a coding agent.
export interface DevError {
  // `compile` and `boot` stopped the server from starting; `request` is a request that threw, `browser` an error an island met on a page, `type` a type error the check beside `kay dev` found.
  kind: 'compile' | 'boot' | 'request' | 'browser' | 'type'
  time: string
  message: string
  // The request that threw, or the page a browser error was met on.
  request?: { method: string, path: string }
  // The island's component a browser error was met in, when the browser knows it.
  island?: string
  // Each compile error's position, from the project's root.
  problems?: { file: string, line: number, column: number, code?: string | undefined, message: string }[]
  // The compile errors as `kay check` prints them, or the stack mapped to `.kay` lines.
  report: string
  // Where the project's own code threw, from its root, and the lines leading to it.
  at?: { file: string, line: number, column: number, frame: string }
}

export const DEV_ERRORS_FILE = 'errors.json'
// A page a crawler or a loop keeps failing on under many paths keeps the file readable.
const MAX_ERRORS = 50
const BOOT = 'boot'
// What `save` writes before renaming it into place, named after its server's pid.
const PARTIAL = /^errors\.json\.(\d+)$/

let tracked: { root: string, file: string, errors: Map<string, DevError>, base: string } | undefined
// The requests that met an error, which their response then never clears.
const failed = new WeakSet<Request>()

// Under `kay dev`, keeps the errors of the requests the last servers met, and forgets why the last one failed to boot: this one either boots or says why.
export function trackDevErrors(root: string): void {
  if (!underKayDev()) {
    tracked = undefined

    return
  }

  if (tracked?.root !== root) {
    const file = join(outputDir(root), DEV_ERRORS_FILE)

    tracked = { root, file, errors: new Map(readErrors(file)), base: '' }
    removeStalePartials(dirname(file))
  }

  tracked.errors.delete(BOOT)
  save()
}

// Why the server failed to boot, which stays listed until a server boots.
export function recordBootFailure(error: unknown): void {
  if (tracked !== undefined)
    neverThrowing(() => bootFailureOf(error))
}

// An error met answering `request`, or one a browser reported of a page, which stays listed until that page or request is answered again without one.
export function recordRequestError(error: unknown, request: Request): void {
  if (tracked === undefined)
    return

  failed.add(request)
  neverThrowing(() => requestErrorOf(error, request))
}

// The type errors the check beside `kay dev` found now, which replace those of the check before: one entry each, at its `.kay` line. `kay dev` says them itself, so nothing is sent back.
export function recordTypeErrors(problems: TypeProblem[]): void {
  if (tracked === undefined)
    return

  neverThrowing(() => {
    const errors = tracked!.errors

    for (const [key, error] of errors) {
      if (error.kind === 'type')
        errors.delete(key)
    }

    const time = new Date().toISOString()

    // Past the cap the first errors stay, as they are the ones to fix first.
    for (const { report, ...problem } of problems.slice(0, MAX_ERRORS))
      errors.set(typeKey(problem), { kind: 'type', time, message: problem.message, problems: [problem], report })

    save()
  })
}

function typeKey({ file, line, column, code }: Pick<TypeProblem, 'file' | 'line' | 'column' | 'code'>): string {
  return `type ${file}:${line}:${column} ${code ?? ''}`
}

// Listing an error never costs the server its answer, nor the app its `onError`: a browser's report may hold a stack no path reads from.
function neverThrowing(run: () => void): void {
  try {
    run()
  }
  catch {}
}

function bootFailureOf(error: unknown): void {
  const diagnostics = error instanceof Error && error.name === 'KayCompileError' ? (error as Error & { diagnostics?: FileDiagnostic[] }).diagnostics : undefined

  if (diagnostics !== undefined && diagnostics.length > 0) {
    const root = tracked!.root
    const problems = diagnostics.map(diagnostic => ({ file: relative(root, diagnostic.file), ...positionAt(diagnostic.source, diagnostic.start), ...diagnostic.code !== undefined && { code: diagnostic.code }, message: diagnostic.message }))

    record(BOOT, { kind: 'compile', time: new Date().toISOString(), message: `${problems.length} compile error${problems.length === 1 ? '' : 's'}`, problems, report: (error as Error).message.trimStart() })

    return
  }

  record(BOOT, { kind: 'boot', time: new Date().toISOString(), ...thrown(error) })
}

function requestErrorOf(error: unknown, request: Request): void {
  const time = new Date().toISOString()

  if (error instanceof Error && error.name === 'BrowserError') {
    const { url, island } = error as Error & { url: string, island?: string }
    const path = appPath(URL.parse(url, 'http://localhost')?.pathname ?? url, tracked!.base)

    record(`browser ${path}`, { kind: 'browser', time, request: { method: 'GET', path }, ...island !== undefined && { island }, ...thrown(error) })

    return
  }

  const method = request.method
  const path = pathOf(request.url)

  record(`request ${method} ${path}`, { kind: 'request', time, request: { method, path }, ...thrown(error) })
}

// Clears what a request last met once it is answered without an error, and for a page what its islands met; `base` is the mount point a browser's page path carries and the app's requests do not.
export function clearDevErrorsOnAnswer(app: Elysia, base: string): void {
  if (tracked === undefined)
    return

  tracked.base = base
  app.onAfterResponse({ as: 'global' }, ({ request, set, responseValue }) => answeredWithoutError(request, statusOf(responseValue, set)))
}

export function answeredWithoutError(request: Request, status: number): void {
  if (tracked === undefined || failed.has(request) || status >= 500)
    return

  const path = pathOf(request.url)
  const cleared = [tracked.errors.delete(`request ${request.method} ${path}`), request.method === 'GET' && tracked.errors.delete(`browser ${path}`)]

  if (cleared.includes(true))
    save()
}

function appPath(path: string, base: string): string {
  return base !== '' && (path === base || path.startsWith(`${base}/`)) ? path.slice(base.length) || '/' : path
}

function thrown(error: unknown): Pick<DevError, 'message' | 'report' | 'at'> {
  const report = describeThrown(error)
  const at = ownPlace(report)

  return { message: error instanceof Error ? error.message : report, report, ...at && { at } }
}

// Where the project's own code threw; none when a frame names no file a path reads from, as a browser's report may.
function ownPlace(report: string): DevError['at'] {
  try {
    const frame = firstOwnFrame(report)

    return frame && excerpt(frame)
  }
  catch {
    return undefined
  }
}

function excerpt(frame: { file: string, line: number, column: number }): DevError['at'] {
  try {
    const source = readFileSync(frame.file, 'utf8')

    return { file: relative(tracked!.root, frame.file), line: frame.line, column: frame.column, frame: codeFrame(source, offsetAt(source, frame)) }
  }
  catch {
    return undefined
  }
}

// The latest error of a kind and place replaces the one before; `kay dev` hears of each, which `--format json` prints.
function record(key: string, error: DevError): void {
  const errors = tracked!.errors

  errors.delete(key)
  errors.set(key, error)

  for (const oldest of errors.keys()) {
    if (errors.size <= MAX_ERRORS)
      break

    errors.delete(oldest)
  }

  save()

  try {
    process.send?.({ devError: error })
  }
  // `kay dev` gone, as when it stops.
  catch {}
}

function readErrors(file: string): [string, DevError][] {
  try {
    const { errors } = JSON.parse(readFileSync(file, 'utf8')) as { errors: DevError[] }

    // A type error is the check's to list again: `kay dev` tells each new server the ones it holds, so a previous run's do not outlive its fix.
    return errors.filter(error => error.kind !== 'type').map(error => [keyOf(error), error])
  }
  catch {
    return []
  }
}

function keyOf(error: DevError): string {
  if (error.kind === 'request')
    return `request ${error.request!.method} ${error.request!.path}`

  if (error.kind === 'type')
    return typeKey(error.problems![0]!)

  return error.kind === 'browser' ? `browser ${error.request!.path}` : BOOT
}

// What a server killed mid-write left; a running server's own is left alone, as it renames it in a moment.
function removeStalePartials(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      const pid = PARTIAL.exec(name)?.[1]

      if (pid !== undefined && !alive(Number(pid)))
        rmSync(join(dir, name), { force: true })
    }
  }
  // No directory yet, as for a project's first server.
  catch {}
}

// Written whole and renamed into place, so a reader never meets half a file.
function save(): void {
  const { file, errors } = tracked!
  const partial = `${file}.${process.pid}`

  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(partial, `${JSON.stringify({ errors: [...errors.values()] }, null, 2)}\n`)
    renameSync(partial, file)
  }
  // A disk full or a directory removed under it costs the agent its list, never the server its answer.
  catch {}
}
