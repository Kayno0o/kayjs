// The built-in `kay` commands, declared for @kaynooo/cli-kit: each parses its own arguments first (so `--help` and shell completion work), then loads what it runs.

import type { Commands, ExitRow } from '@kaynooo/cli-kit'
import type { ScaffoldTemplate } from './new'
import { resolve } from 'node:path'
import { badUsage, Exit, fail, parse } from '@kaynooo/cli-kit'

const TEMPLATES = ['minimal', 'fullstack', 'blog', 'app'] as const
const SIZE_RE = /^(\d+(?:\.\d+)?)\s*(kb)?$/i

const ROOT = { type: 'string', description: 'the app folder, when it is not the current one or the [dir] argument' } as const
const PORT = { type: 'string', description: 'the port to listen on (PORT, then kay.config.ts port, then 3000; 0 picks a free one)' } as const
const HOST = { type: 'string', optional: { bare: '0.0.0.0' }, description: 'the address to bind (HOST, then 127.0.0.1); bare, every interface' } as const

const OK: ExitRow = [0, 'it did what was asked']
const USAGE_EXIT: ExitRow = [2, 'a usage error']

// `--max-js 40kb`, `--max-js 40KB` or `--max-js 40960` (bytes).
function parseSize(raw: string): number {
  const match = SIZE_RE.exec(raw.trim())
  if (match === null)
    return badUsage(`invalid --max-js "${raw}": give the gzipped size of a route's eager JS in bytes or KB, e.g. --max-js 40kb`)
  return Math.round(Number(match[1]) * (match[2] === undefined ? 1 : 1024))
}

function parsePort(raw: string | number | undefined, fallback: number): number {
  if (raw === undefined || raw === '')
    return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535)
    return badUsage(`invalid port "${raw}": give an integer between 0 and 65535`)
  return n
}

// A kay error carries its own `kay: ` or `kay <command>: ` prefix, which the kit prints already: strip it and exit 1.
async function failing<T>(command: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  }
  catch (error) {
    if (error instanceof Exit || !(error instanceof Error))
      throw error
    const prefix = [`kay ${command}: `, 'kay: '].find(each => error.message.startsWith(each))
    if (prefix === undefined)
      throw error
    return fail(error.message.slice(prefix.length), 1)
  }
}

// The app folder: `--root`, else the `[dir]` argument, else where kay runs.
function rootOf(cwd: string, root: string | undefined, dir: string | undefined): string {
  return resolve(cwd, root ?? dir ?? '.')
}

function newCommand(cwd: string): Commands[string] {
  return {
    summary: 'create an app from a template',
    run: async (args) => {
      const { values, positionals: [dir] } = parse(args, 'kay new [options] <dir>: creates an app from a template', {
        template: { type: 'string', choices: TEMPLATES, description: 'the template (minimal)' },
        force: { type: 'boolean', description: 'write into a folder that is not empty' },
        root: ROOT,
      }, { positionals: ['<dir>'], exits: [OK, [1, 'the folder is not empty'], USAGE_EXIT] })
      const { scaffoldProject } = await import('./new')
      const template = (values.template ?? 'minimal') as ScaffoldTemplate
      const res = await failing('new', async () => scaffoldProject(rootOf(cwd, values.root, dir), { template, force: values.force === true }))
      console.log(`Created Kay (${template}) project in ${res.root} (${res.files.length} files)`)
      console.log(`\nNext steps:\n  cd ${dir}\n  bun install\n  bun run dev`)
      return 0
    },
  }
}

function checkCommand(cwd: string): Commands[string] {
  return {
    summary: 'report every mistake kay can find in the app',
    run: async (args) => {
      const { values, positionals: [dir] } = parse(args, 'kay check [options] [dir]: reports every mistake kay can find in the app: the compile, the config, the routes and the types', {
        'no-typecheck': { type: 'boolean', description: 'skip the TypeScript check' },
        'json': { type: 'boolean', description: 'print { ok, checkedFiles, typecheck, errors, warnings } as JSON, each diagnostic with file, line, col, severity and message' },
        'strict': { type: 'boolean', description: 'fail on a warning too' },
        'root': ROOT,
      }, { positionals: ['[dir]'], exits: [[0, 'no error found (warnings count only with --strict)'], [1, 'at least one error found, or a warning with --strict'], USAGE_EXIT] })
      const { checkProject, diagnosticData } = await import('./check')
      const t0 = performance.now()
      const res = await checkProject(rootOf(cwd, values.root, dir), { skipTypecheck: values['no-typecheck'] === true })
      const ms = (performance.now() - t0).toFixed(1)
      const failed = !res.ok || (values.strict === true && res.warnings.length > 0)
      if (values.json === true) {
        const errors = res.errors.map(e => diagnosticData(e, 'error'))
        const warnings = res.warnings.map(w => diagnosticData(w, 'warning'))
        console.log(JSON.stringify({ ok: !failed, checkedFiles: res.checkedFiles, typecheck: res.typecheck, errors, warnings }, null, 2))
        return failed ? 1 : 0
      }
      for (const warning of res.warnings)
        console.warn(warning)
      for (const e of res.errors)
        console.error(e)
      const typecheck = res.typecheck.ran ? `typechecked with ${res.typecheck.tool}` : `no typecheck: ${res.typecheck.reason}`
      if (failed) {
        if (res.ok)
          console.error(`kay check: ${res.warnings.length} warning${res.warnings.length === 1 ? '' : 's'}, which --strict counts as errors.`)
        if (!res.typecheck.ran)
          console.error(`kay check: ${typecheck}.`)
        return 1
      }
      console.log(`kay check passed (${res.checkedFiles} files, ${typecheck}) in ${ms} ms`)
      return 0
    },
  }
}

function upgradeCommand(cwd: string): Commands[string] {
  return {
    summary: 'rewrite an app written for kay v1 to the v2 API',
    run: async (args) => {
      const { values, positionals: [dir] } = parse(args, 'kay upgrade [options] [dir]: rewrites an app written for kay v1 to the v2 API', {
        'no-install': { type: 'boolean', description: 'do not run bun install after rewriting package.json' },
        'root': ROOT,
      }, { positionals: ['[dir]'], exits: [[0, 'every file was rewritten and nothing is left to do by hand'], [1, 'bun install failed, or steps are left to do by hand (printed)'], USAGE_EXIT] })
      const root = rootOf(cwd, values.root, dir)
      const { upgradeProject } = await import('./upgrade')
      const res = upgradeProject(root)
      for (const file of res.changed)
        console.log(`  ${file}`)
      console.log(`kay upgrade rewrote ${res.changed.length} files`)
      if (res.changed.includes('package.json') && values['no-install'] !== true) {
        const install = Bun.spawnSync(['bun', 'install'], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
        if (install.exitCode !== 0)
          return 1
      }
      for (const line of res.manual)
        console.error(line)
      if (res.manual.length > 0)
        return 1
      console.log('Next: kay check')
      return 0
    },
  }
}

function inspectCommand(cwd: string): Commands[string] {
  return {
    summary: 'inspect routes, islands, actions and plugins without bundling',
    run: async (args) => {
      const { values, positionals: [dir] } = parse(args, 'kay inspect [options] [dir]: inspects routes, islands, actions and plugins statically without bundling', {
        json: { type: 'boolean', description: 'print { routes, islands, actions, plugins } as JSON' },
        root: ROOT,
      }, { positionals: ['[dir]'], exits: [OK, [1, 'the config or a source file failed to load'], USAGE_EXIT] })
      const { formatInspectReport, inspectProject } = await import('./inspect')
      const report = await failing('inspect', () => inspectProject(rootOf(cwd, values.root, dir)))
      console.log(values.json === true ? JSON.stringify(report, null, 2) : formatInspectReport(report))
      return 0
    },
  }
}

function buildCommand(cwd: string): Commands[string] {
  return {
    summary: 'build the app into dist/',
    run: async (args) => {
      const { values, positionals: [dir] } = parse(args, 'kay build [options] [dir]: builds the app into dist/', {
        'static': { type: 'boolean', description: 'export plain HTML files instead of a server' },
        'compile': { type: 'string', optional: { bare: '' }, description: 'also produce one binary, at [out] when given' },
        'analyze': { type: 'boolean', description: 'list each island with why it is one' },
        'json': { type: 'boolean', description: 'with --analyze, print the bundle report as JSON' },
        'max-js': { type: 'string', description: 'fail a route whose eager JS gzips over this size (40kb, or bytes)' },
        'root': ROOT,
      }, { positionals: ['[dir]'], exits: [[0, 'the build succeeded'], [1, 'the build failed, or a route is over --max-js'], USAGE_EXIT] })
      if (values.json === true && values.analyze !== true)
        return badUsage('--json requires --analyze: pass kay build --analyze --json')
      const maxJs = values['max-js'] === undefined ? undefined : parseSize(values['max-js'])
      const compile = values.compile === undefined ? undefined : values.compile === '' ? true : values.compile
      const analyzeJson = values.analyze === true && values.json === true
      const { build } = await import('../build/index')
      const t0 = performance.now()
      const manifest = await failing('build', async () => build({ root: rootOf(cwd, values.root, dir), static: values.static === true, compile, analyze: values.analyze === true, analyzeJson, maxJs }))
      const ms = (performance.now() - t0).toFixed(1)
      if (!analyzeJson)
        console.log(`kay build done in ${ms} ms (${manifest.routes.length} routes, ${manifest.assets.length} client assets, ${manifest.actions.length} actions)`)
      return 0
    },
  }
}

const SERVE_EXITS: ExitRow[] = [[0, 'the server started'], [1, 'the config or the server failed to load'], USAGE_EXIT]

function startCommand(cwd: string): Commands[string] {
  return {
    summary: 'serve the built app',
    run: async (args) => {
      const { values, positionals: [dir] } = parse(args, 'kay start [options] [dir]: serves the built app', { port: PORT, host: HOST, root: ROOT }, { positionals: ['[dir]'], exits: SERVE_EXITS })
      const root = rootOf(cwd, values.root, dir)
      process.env.NODE_ENV ??= 'production'
      const { loadConfig } = await import('../plugins/index')
      const config = await failing('start', async () => loadConfig(root))
      const port = parsePort(values.port ?? (process.env.PORT || config.port), 3000)
      const hostname = values.host ?? (process.env.HOST || '127.0.0.1')
      const { createServer } = await import('../server/index')
      const { handleSignals } = await import('../server/lifecycle')
      const app = await failing('start', async () => createServer({ root }))
      const server = app.serve(port, hostname)
      handleSignals(app, server)
      console.log(`kay server listening on http://${hostname}:${server.port}`)
      return 0
    },
  }
}

function devCommand(cwd: string): Commands[string] {
  return {
    summary: 'serve the app with rebuild on change',
    run: async (args) => {
      const { values, positionals: [dir] } = parse(args, 'kay dev [options] [dir]: serves the app and rebuilds it when a file changes', { port: PORT, host: HOST, root: ROOT }, { positionals: ['[dir]'], exits: SERVE_EXITS })
      const root = rootOf(cwd, values.root, dir)
      const { loadConfig } = await import('../plugins/index')
      const config = await failing('dev', async () => loadConfig(root, { dev: true }))
      const port = parsePort(values.port ?? (process.env.PORT || config.port), 3000)
      const hostname = values.host ?? (process.env.HOST || '127.0.0.1')
      const { devServer } = await import('../dev/index')
      await failing('dev', async () => devServer({ root, port, hostname }))
      return 0
    },
  }
}

export function builtinCommands(cwd: string): Commands {
  return {
    new: newCommand(cwd),
    check: checkCommand(cwd),
    inspect: inspectCommand(cwd),
    dev: devCommand(cwd),
    build: buildCommand(cwd),
    start: startCommand(cwd),
    upgrade: upgradeCommand(cwd),
  }
}

// The `--root <dir>` (or `--root=<dir>`) of a plugin command's arguments, and the arguments without it.
export function takeRoot(args: readonly string[], cwd: string): { root: string, rest: string[] } {
  const rest: string[] = []
  let root: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--root') {
      const next = args[i + 1]
      if (next === undefined || next.startsWith('-'))
        return badUsage('--root requires a directory path')
      root = next
      i++
    }
    else if (arg.startsWith('--root=')) {
      root = arg.slice('--root='.length)
    }
    else {
      rest.push(arg)
    }
  }
  return { root: resolve(cwd, root ?? '.'), rest }
}
