import type { BuildOptions, BuildResult, BuildStage } from '../build/pipeline'
import type { Command, FailureProblem, ProblemFormat } from './command'
import { writeSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { buildProject } from '../build/pipeline'
import { formatSizeReport } from '../build/report'
import { KayCompileError } from '../build/transform'
import { fromCompile } from '../check/shadow-types'
import { loadConfig } from '../config'
import { ContentError } from '../content/validate'
import { buildingWithoutEnv } from '../server/env'
import { ExportError } from '../server/prerender'
import { count, done, failureProblem, formatOption, printDocument, printedProblems, printFailure, printProblems, PROBLEM_FORMATS, problemCounts, projectRoot, withStdoutOnStderr, workflowCommand } from './command'
import { progressLine } from './progress'

// With `--compile`, also bundles the server and all of it into one executable; with `--static`, writes the whole site to `--outdir`, `dist` by default, for a host with no server. `--no-check` builds without checking.
export const build: Command = {
  usage: 'build [dir] [--compile <executable>] [--entry <file>] [--static] [--outdir <dir>] [--no-check] [--analyze] [-p tsconfig.json] [--format text|github|json]',
  options: { 'compile': { type: 'string' }, 'entry': { type: 'string' }, 'static': { type: 'boolean' }, 'outdir': { type: 'string' }, 'no-check': { type: 'boolean' }, 'analyze': { type: 'boolean' }, 'project': { type: 'string', short: 'p' }, 'format': { type: 'string' } },
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

    if (entry !== undefined && typeof compile !== 'string')
      return refuse('--entry names the server an executable runs, so it goes with --compile')

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
      compile: typeof compile === 'string' ? { outfile: resolve(compile), entry } : undefined,
      analyze: values.analyze === true,
    }

    if (format === 'json')
      return buildToDocument(root, options)

    // On a terminal, a line tells what the build is doing until it ends; annotations are for CI, which has none.
    const progress = format === 'text' ? progressLine() : undefined
    let result: BuildResult

    try {
      result = await buildProject(root, await loadConfig(root), { ...options, onStage: async (stage, result) => printStage(stage, result, format), onProgress: progress?.update })
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
async function printStage(stage: BuildStage, result: BuildResult, format: ProblemFormat): Promise<void> {
  if (stage === 'check')
    await printProblems(result.checked, false, format)

  if (stage === 'output') {
    await printProblems(result.linted, false, format)

    if (result.built) {
      const { islands, stylesheets, prerendered, entries, report, ms } = result.built

      done('built', `${count(islands, 'island')}, ${count(stylesheets, 'stylesheet')} and ${count(prerendered, 'prerendered page')}${entries > 0 ? ` from ${entries} content ${entries === 1 ? 'entry' : 'entries'}` : ''}`, ms)

      if (report)
        console.log(formatSizeReport(report))
    }
  }

  if (stage === 'export' && result.exported)
    done('exported', `${count(result.exported.pages, 'page')} and ${count(result.exported.files, 'other file')} to ${shown(result.exported.dir)}`, result.exported.ms)

  if (stage === 'compile' && result.compiled)
    done('compiled', shown(result.compiled.executable), result.compiled.ms)
}

// The whole build as one document once it ends, `kay check`'s problems and counts first, then what each stage made and the stage that stopped it; what the app prints meanwhile goes to stderr.
// Code the build runs that ends the process leaves the problems found so far, and the stage it ended in, written at once as the process goes.
async function buildToDocument(root: string, options: BuildOptions): Promise<number> {
  let result: BuildResult
  let found: FailureProblem[] = []
  let running: BuildStage = 'check'
  const ended = (code: number) => {
    const problems = [...found, failureProblem(`the build ended with exit code ${code} before it was done`, 'json')]

    writeSync(1, `${JSON.stringify({ ...problemCounts(problems), problems, failed: { stage: running } })}\n`)
  }
  const onStage = async (stage: BuildStage, sofar: BuildResult) => {
    found = await printedProblems([...sofar.checked, ...sofar.linted])
    running = stage === 'check' ? 'output' : stage === 'output' && options.exportTo !== undefined ? 'export' : 'compile'
  }

  process.on('exit', ended)

  try {
    result = await withStdoutOnStderr(async () => buildProject(root, await loadConfig(root), { ...options, onStage }))
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
    ...built && { built: { islands: built.islands, stylesheets: built.stylesheets, prerendered: built.prerendered, entries: built.entries, ms: Math.round(built.ms), sizes: built.report } },
    ...exported && { exported: { pages: exported.pages, files: exported.files, dir: shown(exported.dir), ms: Math.round(exported.ms) } },
    ...compiled && { compiled: { executable: shown(compiled.executable), ms: Math.round(compiled.ms) } },
  })

  return failed ? 1 : 0
}

// A template that does not compile, at its place in the file, as `kay check` gives it; anything else as one problem.
async function failureProblems(error: unknown, format: ProblemFormat): Promise<FailureProblem[]> {
  if (error instanceof KayCompileError)
    return printedProblems(error.diagnostics.map(diagnostic => fromCompile(diagnostic.file, diagnostic.source, diagnostic)), format)

  return [failureProblem(buildError(error), format)]
}

function buildError(error: unknown): unknown {
  return error instanceof KayCompileError || error instanceof ContentError || error instanceof ExportError ? error.message.trimStart() : error
}

function shown(path: string): string {
  return relative(process.cwd(), path) || '.'
}
