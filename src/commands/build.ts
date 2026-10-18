import type { BuildOptions, BuildProgress, BuildResult, BuildStage } from '../build/pipeline'
import type { Command, FailureProblem, ProblemFormat } from './command'
import { writeSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { buildProject } from '../build/pipeline'
import { formatBuildReport } from '../build/report'
import { KayCompileError } from '../build/transform'
import { fromCompile } from '../check/shadow-types'
import { errorCodeOf } from '../compiler/errors'
import { loadConfig } from '../config'
import { ContentError } from '../content/validate'
import { buildingWithoutEnv } from '../server/env-state'
import { ExportError } from '../server/prerender'
import { count, done, explainHint, failureProblem, formatOption, printDocument, printedProblems, printFailure, printProblems, PROBLEM_FORMATS, problemCounts, projectRoot, withStdoutOnStderr, workflowCommand } from './command'
import { progressLine } from './progress'
import { USAGES } from './usages'

// With `--compile`, also bundles the server and all of it into one executable; with `--static`, writes the whole site to `--outdir`, `dist` by default, for a host with no server. `--no-check` builds without checking, `--no-cache` without what earlier builds left in `.kay/cache`.
export const build: Command = {
  usage: USAGES.build,
  options: { 'compile': { type: 'string' }, 'verify': { type: 'boolean' }, 'entry': { type: 'string' }, 'static': { type: 'boolean' }, 'outdir': { type: 'string' }, 'no-check': { type: 'boolean' }, 'no-cache': { type: 'boolean' }, 'analyze': { type: 'boolean' }, 'deny-warnings': { type: 'boolean' }, 'project': { type: 'string', short: 'p' }, 'format': { type: 'string' }, 'quiet': { type: 'boolean' } },
  positionals: 1,
  run: async ({ values, positionals }, refuseUsage) => {
    const { compile, outdir, project: tsconfig } = values
    const entry = typeof values.entry === 'string' ? resolve(values.entry) : undefined
    const exported = values.static === true
    const checking = values['no-check'] !== true
    const format = formatOption('build', values.format, PROBLEM_FORMATS)

    if (format === undefined)
      return 1

    // The text output prints the usage after why; the others say why in their format.
    const refuse = (reason: string) => {
      if (format === 'text')
        return refuseUsage(reason)

      printFailure('build', reason, format)

      return 1
    }

    if (!checking && typeof tsconfig === 'string')
      return refuse('-p names the tsconfig the build checks with, so it does not go with --no-check')

    if (values.verify === true && typeof compile !== 'string')
      return refuse('--verify starts the executable --compile writes, so it goes with --compile')

    if (exported && typeof compile === 'string')
      return refuse('--static writes files for a host with no server, and --compile a server; pick one')

    if (typeof outdir === 'string' && !exported)
      return refuse('--outdir names where --static writes the site, so it goes with --static')

    const root = projectRoot('build', positionals[0], format)

    if (root === undefined)
      return 1

    buildingWithoutEnv()

    const options: BuildOptions = {
      check: checking && { tsconfig: typeof tsconfig === 'string' ? tsconfig : undefined, entry },
      exportTo: exported ? resolve(typeof outdir === 'string' ? outdir : join(root, 'dist')) : undefined,
      compile: typeof compile === 'string' ? { outfile: resolve(compile), entry, verify: values.verify === true } : undefined,
      fresh: values['no-cache'] === true,
      analyze: values.analyze === true,
      denyWarnings: values['deny-warnings'] === true,
    }

    if (format === 'json')
      return buildToDocument(root, options)

    // On a terminal, a line tells what the build is doing until it ends; annotations are for CI, which has none.
    // Not with stdout piped either, whose lines would reach the terminal after the frame drawn since.
    const progress = format === 'text' && process.stdout.isTTY ? progressLine() : undefined
    let result: BuildResult

    try {
      result = await buildProject(root, await loadConfig(root), { ...options, onStage: async (stage, result) => printStage(stage, result, format, values.quiet === true, values['deny-warnings'] === true), onProgress: progress?.update })
    }
    finally {
      progress?.stop()
    }

    const { failed } = result

    if (failed?.stage === 'check') {
      console.error('kay build: nothing built, as kay check found the problems above; --no-check builds anyway')

      return 1
    }

    if (failed?.stage === 'output' && failed.error === undefined) {
      console.error('kay build: nothing built, as the prerendered pages break the lints above; --no-check builds anyway')

      return 1
    }

    if (failed) {
      console.error(buildError(failed.error))

      const hint = explainHint(failed.error)

      if (hint !== undefined && format !== 'github')
        console.error(hint)

      if (format === 'github') {
        for (const problem of await failureProblems(failed.error, format))
          console.log(workflowCommand(problem, 'build'))
      }

      return 1
    }

    return 0
  },
}

// Each stage as it ends, so its problems come before what a later stage's code logs, and are shown though that code ends the process.
// `denyWarnings` says in the count that the warnings fail the build.
// `quiet` leaves the size report out, each stage still saying what it made.
async function printStage(stage: BuildStage, result: BuildResult, format: ProblemFormat, quiet: boolean, denyWarnings: boolean): Promise<void> {
  if (stage === 'check')
    await printProblems(result.checked, denyWarnings, format)

  if (stage === 'output') {
    await printProblems(result.linted, denyWarnings, format)

    if (result.built) {
      const { islands, stylesheets, prerendered, entries, report, summary, previous, ms } = result.built

      done('built', `${count(islands, 'island')}, ${count(stylesheets, 'stylesheet')} and ${count(prerendered, 'prerendered page')}${entries > 0 ? ` from ${entries} content ${entries === 1 ? 'entry' : 'entries'}` : ''}`, ms)

      if (!quiet)
        console.log(`\n${formatBuildReport(report, summary, { width: process.stdout.isTTY ? process.stdout.columns : undefined, previous })}`)
    }
  }

  if (stage === 'export' && result.exported)
    done('exported', `${count(result.exported.pages, 'page')} and ${count(result.exported.files, 'other file')} to ${shown(result.exported.dir)}`, result.exported.ms)

  if (stage === 'compile' && result.compiled)
    done('compiled', shown(result.compiled.executable), result.compiled.ms)

  if (stage === 'compile' && result.compiled?.verifiedMs !== undefined)
    done('verified', 'the executable started and answered its health route', result.compiled.verifiedMs)
}

// The whole build as one document once it ends, `kay check`'s problems and counts first, then what each stage made and the stage that stopped it; what the app prints meanwhile goes to stderr.
// Code the build runs that ends the process leaves the problems found so far, and the stage it ended in, written at once as the process goes, and fails it even on exit code 0, as the build never finished.
async function buildToDocument(root: string, options: BuildOptions): Promise<number> {
  let result: BuildResult
  let found: FailureProblem[] = []
  let running: BuildStage = options.check === false ? 'bundle' : 'check'
  const ended = (code: number) => {
    const problems = [...found, failureProblem(`the build ended with exit code ${code} before it was done`, 'json', null)]

    writeSync(1, `${JSON.stringify({ ...problemCounts(problems), problems, failed: { stage: running } })}\n`)

    if (code === 0)
      process.exitCode = 1
  }
  // The check ending first leaves the browser bundle running alone.
  const onProgress = ({ step }: BuildProgress) => {
    if (step === 'bundling' && running === 'check')
      running = 'bundle'
  }
  const onStage = async (stage: BuildStage, sofar: BuildResult) => {
    found = await printedProblems([...sofar.checked, ...sofar.linted])

    if (stage === 'check')
      running = 'output'
    else
      running = stage === 'output' && options.exportTo !== undefined ? 'export' : 'compile'
  }

  process.on('exit', ended)

  try {
    result = await withStdoutOnStderr(async () => buildProject(root, await loadConfig(root), { ...options, onStage, onProgress }))
  }
  catch (error) {
    process.off('exit', ended)
    printFailure('build', error, 'json')

    return 1
  }

  process.off('exit', ended)

  const { failed, built, exported, compiled } = result

  if (failed?.error !== undefined)
    console.error(buildError(failed.error))

  const problems: FailureProblem[] = [...await printedProblems([...result.checked, ...result.linted]), ...failed?.error === undefined ? [] : await failureProblems(failed.error, 'json')]

  printDocument({
    ...problemCounts(problems),
    problems,
    ...failed && { failed: { stage: failed.stage } },
    ...built && { built: { islands: built.islands, stylesheets: built.stylesheets, prerendered: built.prerendered, entries: built.entries, ms: Math.round(built.ms), sizes: built.report, routes: built.summary.routes, stages: built.summary.stages.map(stage => ({ name: stage.name, ms: Math.round(stage.ms) })), caches: built.summary.caches } },
    ...exported && { exported: { pages: exported.pages, files: exported.files, dir: shown(exported.dir), ms: Math.round(exported.ms) } },
    ...compiled && { compiled: { executable: shown(compiled.executable), ms: Math.round(compiled.ms), ...compiled.verifiedMs !== undefined && { verifiedMs: Math.round(compiled.verifiedMs) } } },
  })

  return failed ? 1 : 0
}

// A template that does not compile, at its place in the file, as `kay check` gives it; anything else as one problem.
async function failureProblems(error: unknown, format: ProblemFormat): Promise<FailureProblem[]> {
  if (error instanceof KayCompileError)
    return printedProblems(error.diagnostics.map(diagnostic => fromCompile(diagnostic.file, diagnostic.source, diagnostic)), format)

  if (error instanceof ExportError)
    return error.problems.map(problem => failureProblem(problem.message, format, problem.code))

  return [failureProblem(buildError(error), format, errorCodeOf(error) ?? null)]
}

function buildError(error: unknown): unknown {
  return error instanceof KayCompileError || error instanceof ContentError || error instanceof ExportError ? error.message.trimStart() : error
}

function shown(path: string): string {
  return relative(process.cwd(), path) || '.'
}
