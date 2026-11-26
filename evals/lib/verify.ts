import type { BundleReport } from '../../packages/kay/src/build/report'
import type { CheckDiagnostic } from '../../packages/kay/src/cli/check'
import type { BuildSummary, CheckSummary, TaskDefinition, TaskGrade, TestRunSummary } from './types'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { testApp } from '../../packages/kay/src/test/index'
import { parseTranscriptFile } from './metrics'
import { KAY_CLI_ENTRY, parseSizeBytes } from './workspace'

interface KayCheckJson {
  ok: boolean
  checkedFiles: number
  errors: CheckDiagnostic[]
  warnings: CheckDiagnostic[]
}

export interface GradeOptions {
  transcriptPath?: string
  skipTests?: boolean
}

function hasTestFiles(dir: string): boolean {
  const skip = new Set(['node_modules', 'dist', '.git', '.kay-cache'])
  const walk = (cur: string): boolean => {
    if (!existsSync(cur))
      return false
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      if (skip.has(entry.name))
        continue
      const abs = join(cur, entry.name)
      if (entry.isDirectory()) {
        if (walk(abs))
          return true
      }
      else if (entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
        return true
      }
    }
    return false
  }
  return walk(dir)
}

function runKayCheck(dir: string): CheckSummary {
  const proc = Bun.spawnSync([process.execPath, KAY_CLI_ENTRY, 'check', '--json', dir], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = proc.stdout.toString().trim()
  const stderr = proc.stderr.toString().trim()

  if (stdout.startsWith('{')) {
    try {
      const parsed = JSON.parse(stdout) as Partial<KayCheckJson>
      const errors = Array.isArray(parsed.errors) ? parsed.errors : []
      const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : []
      const ok = proc.exitCode === 0 && parsed.ok === true && errors.length === 0
      return {
        ok,
        checkedFiles: typeof parsed.checkedFiles === 'number' ? parsed.checkedFiles : 0,
        errorCount: errors.length,
        warningCount: warnings.length,
        errors,
        warnings,
      }
    }
    catch (err) {
      return {
        ok: false,
        checkedFiles: 0,
        errorCount: 1,
        warningCount: 0,
        errors: [{ severity: 'error', message: `Failed to parse kay check JSON: ${err instanceof Error ? err.message : String(err)}` }],
        warnings: [],
        rawOutput: `${stdout}\n${stderr}`.trim(),
      }
    }
  }

  const msg = stderr || stdout || `kay check exited with code ${proc.exitCode}`
  return {
    ok: false,
    checkedFiles: 0,
    errorCount: 1,
    warningCount: 0,
    errors: [{ severity: 'error', message: msg }],
    warnings: [],
    rawOutput: msg,
  }
}

function parseBundleReport(stdout: string): BundleReport | undefined {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start)
    return undefined
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as Partial<BundleReport>
    if (!Array.isArray(parsed.routes))
      return undefined
    return parsed as BundleReport
  }
  catch {
    return undefined
  }
}

function runKayBuild(dir: string, maxJs?: string): { summary: BuildSummary, report?: BundleReport } {
  const args = [process.execPath, KAY_CLI_ENTRY, 'build', '--analyze', '--json']
  if (maxJs !== undefined)
    args.push('--max-js', maxJs)
  args.push(dir)

  const proc = Bun.spawnSync(args, {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = proc.stdout.toString().trim()
  const stderr = proc.stderr.toString().trim()
  const report = parseBundleReport(stdout)

  const routeWeights = (report?.routes ?? []).map(r => ({
    path: r.path,
    jsGzip: r.jsGzip,
    cssGzip: r.cssGzip,
    firstLoad: r.firstLoad,
    islands: r.islands.length,
  }))
  const maxEagerJsBytes = routeWeights.reduce((max, r) => Math.max(max, r.jsGzip), 0)
  const maxJsBytes = maxJs !== undefined ? parseSizeBytes(maxJs) : undefined
  const budgetExceeded = /over --max-js/i.test(stderr)
    || (maxJsBytes !== undefined && report !== undefined && maxEagerJsBytes > maxJsBytes)

  const ok = proc.exitCode === 0 && !budgetExceeded
  const errorText = ok ? undefined : (stderr || stdout || `kay build exited with code ${proc.exitCode}`)

  const summary: BuildSummary = {
    ok,
    maxEagerJsBytes,
    routeWeights,
    budgetExceeded,
    ...(errorText !== undefined ? { error: errorText } : {}),
  }
  return report !== undefined ? { summary, report } : { summary }
}

function runWorkspaceTests(dir: string): TestRunSummary {
  if (!hasTestFiles(dir)) {
    return { ran: false, ok: true, exitCode: 0, output: '' }
  }
  const proc = Bun.spawnSync([process.execPath, 'test'], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = `${proc.stdout.toString()}\n${proc.stderr.toString()}`.trim()
  return {
    ran: true,
    ok: proc.exitCode === 0,
    exitCode: proc.exitCode,
    output,
  }
}

export async function gradeTask(
  task: TaskDefinition,
  targetDir: string,
  options: GradeOptions = {},
): Promise<TaskGrade> {
  const t0 = performance.now()
  const dir = resolve(targetDir)
  const maxJsBytes = task.spec.maxJs !== undefined ? parseSizeBytes(task.spec.maxJs) : undefined

  if (!existsSync(dir)) {
    const check: CheckSummary = {
      ok: false,
      checkedFiles: 0,
      errorCount: 1,
      warningCount: 0,
      errors: [{ severity: 'error', message: `Task directory does not exist: ${dir}` }],
      warnings: [],
    }
    const build: BuildSummary = {
      ok: false,
      maxEagerJsBytes: 0,
      routeWeights: [],
      budgetExceeded: false,
      error: `Task directory does not exist: ${dir}`,
    }
    return {
      taskId: task.spec.id,
      title: task.spec.title,
      dir,
      ok: false,
      durationMs: Math.round(performance.now() - t0),
      ...(task.spec.maxJs !== undefined ? { maxJs: task.spec.maxJs } : {}),
      ...(maxJsBytes !== undefined ? { maxJsBytes } : {}),
      check,
      build,
      tests: { ran: false, ok: false, exitCode: 1, output: '' },
      assertions: [{ name: 'workspace exists', ok: false, detail: `Directory not found: ${dir}` }],
    }
  }

  const check = runKayCheck(dir)
  const { summary: build, report: bundleReport } = runKayBuild(dir, task.spec.maxJs)
  const tests = options.skipTests === true
    ? { ran: false, ok: true, exitCode: 0, output: '' }
    : runWorkspaceTests(dir)

  let assertions = [] as TaskGrade['assertions']
  const manifestPath = join(dir, 'dist/manifest.json')
  if (existsSync(manifestPath)) {
    let appInstance: Awaited<ReturnType<typeof testApp>> | undefined
    try {
      appInstance = await testApp({ root: dir, prebuilt: true })
      assertions = await task.verify({
        dir,
        task: task.spec,
        app: appInstance,
        ...(bundleReport !== undefined ? { bundleReport } : {}),
      })
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      assertions = [{ name: 'load & verify built app', ok: false, detail: msg }]
    }
    finally {
      await appInstance?.app.dispose?.()
    }
  }
  else {
    assertions = [{
      name: 'built app manifest exists',
      ok: false,
      detail: build.error ?? 'dist/manifest.json was not produced by kay build',
    }]
  }

  const metrics = options.transcriptPath !== undefined
    ? parseTranscriptFile(options.transcriptPath)
    : undefined

  const assertionsOk = assertions.length > 0 && assertions.every(a => a.ok)
  const ok = check.ok && build.ok && tests.ok && assertionsOk

  return {
    taskId: task.spec.id,
    title: task.spec.title,
    dir,
    ok,
    durationMs: Math.round(performance.now() - t0),
    ...(task.spec.maxJs !== undefined ? { maxJs: task.spec.maxJs } : {}),
    ...(maxJsBytes !== undefined ? { maxJsBytes } : {}),
    check,
    build,
    tests,
    assertions,
    ...(metrics !== undefined ? { metrics } : {}),
  }
}
