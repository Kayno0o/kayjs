import type { Command } from './command'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { buildProject } from '../build/pipeline'
import { formatSizeReport } from '../build/report'
import { KayCompileError } from '../build/transform'
import { loadConfig } from '../config'
import { ContentError } from '../content/validate'
import { buildingWithoutEnv } from '../server/env'
import { ExportError } from '../server/prerender'
import { count, done, printProblems, projectRoot } from './command'

// With `--compile`, also bundles the server and all of it into one executable; with `--static`, writes the whole site to `--outdir`, `dist` by default, for a host with no server. `--no-check` builds without checking.
export const build: Command = {
  usage: 'build [dir] [--compile <executable>] [--entry <file>] [--static] [--outdir <dir>] [--no-check] [--analyze] [-p tsconfig.json]',
  options: { 'compile': { type: 'string' }, 'entry': { type: 'string' }, 'static': { type: 'boolean' }, 'outdir': { type: 'string' }, 'no-check': { type: 'boolean' }, 'analyze': { type: 'boolean' }, 'project': { type: 'string', short: 'p' } },
  positionals: 1,
  run: async ({ values, positionals }, refuse) => {
    const { compile, outdir, project: tsconfig } = values
    const entry = typeof values.entry === 'string' ? resolve(values.entry) : undefined
    const exported = values.static === true
    const checking = values['no-check'] !== true

    if (!checking && typeof tsconfig === 'string')
      return refuse('-p names the tsconfig the build checks with, so it does not go with --no-check')

    if (entry !== undefined && typeof compile !== 'string')
      return refuse('--entry names the server an executable runs, so it goes with --compile')

    if (exported && typeof compile === 'string')
      return refuse('--static writes files for a host with no server, and --compile a server; pick one')

    if (typeof outdir === 'string' && !exported)
      return refuse('--outdir names where --static writes the site, so it goes with --static')

    const root = projectRoot('build', positionals[0])

    if (root === undefined)
      return 1

    buildingWithoutEnv()

    const result = await buildProject(root, await loadConfig(root), {
      check: checking && { tsconfig: typeof tsconfig === 'string' ? tsconfig : undefined, entry },
      exportTo: exported ? resolve(typeof outdir === 'string' ? outdir : join(root, 'dist')) : undefined,
      compile: typeof compile === 'string' ? { outfile: resolve(compile), entry } : undefined,
      analyze: values.analyze === true,
    })
    const { failed, built } = result

    await printProblems(result.checked)

    if (failed?.stage === 'check') {
      console.error('kay build: nothing built, as kay check found the problems above; --no-check builds anyway')

      return 1
    }

    await printProblems(result.linted)

    if (failed && !('error' in failed)) {
      console.error('kay build: nothing built, as the prerendered pages break the lints above; --no-check builds anyway')

      return 1
    }

    if (built) {
      const { islands, stylesheets, prerendered, entries, report, ms } = built

      done('built', `${count(islands, 'island')}, ${count(stylesheets, 'stylesheet')} and ${count(prerendered, 'prerendered page')}${entries > 0 ? ` from ${entries} content ${entries === 1 ? 'entry' : 'entries'}` : ''}`, ms)

      if (report)
        console.log(formatSizeReport(report))
    }

    if (result.exported)
      done('exported', `${count(result.exported.pages, 'page')} and ${count(result.exported.files, 'other file')} to ${relative(process.cwd(), result.exported.dir) || '.'}`, result.exported.ms)

    if (result.compiled)
      done('compiled', relative(process.cwd(), result.compiled.executable), result.compiled.ms)

    if (failed) {
      console.error(buildError(failed.error))

      return 1
    }

    return 0
  },
}

function buildError(error: unknown): unknown {
  return error instanceof KayCompileError || error instanceof ContentError || error instanceof ExportError ? error.message.trimStart() : error
}
