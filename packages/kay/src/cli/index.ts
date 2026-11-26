#!/usr/bin/env bun
// Kay v2 minimal CLI: `kay new`, `kay check`, `kay dev`, `kay build [--static] [--compile [out]]`, `kay start`,
// plus plugin-registered commands (e.g. `kay ui-eject <grammar> [dest]`, `kay mcp-footprint`).

import { resolve } from 'node:path'
import { build } from '../build/index'
import { devServer } from '../dev/index'
import { loadConfig } from '../plugins/index'
import { createServer } from '../server/index'
import { handleSignals } from '../server/lifecycle'
import { checkProject } from './check'
import { scaffoldProject } from './new'
import { upgradeProject } from './upgrade'

const BUILTIN_COMMANDS = new Set(['new', 'check', 'build', 'start', 'dev', 'upgrade'])
const VALID_TEMPLATES = new Set(['minimal', 'fullstack', 'blog', 'app'])

const VALUE_FLAGS = new Set(['--port', '--host', '--template', '--root', '--max-js'])
const SIZE_RE = /^(\d+(?:\.\d+)?)\s*(kb)?$/i
const OPTIONAL_VALUE_FLAGS = new Set(['--compile'])
const BOOLEAN_FLAGS = new Set(['--static', '--analyze', '--force', '--no-typecheck', '--no-install', '--help', '-h'])

const ALLOWED_FLAGS_BY_CMD: Record<string, ReadonlySet<string>> = {
  new: new Set(['--template', '--force', '--root', '--help', '-h']),
  check: new Set(['--no-typecheck', '--root', '--help', '-h']),
  build: new Set(['--static', '--analyze', '--compile', '--max-js', '--root', '--help', '-h']),
  start: new Set(['--port', '--host', '--root', '--help', '-h']),
  dev: new Set(['--port', '--host', '--root', '--help', '-h']),
  upgrade: new Set(['--no-install', '--root', '--help', '-h']),
}

export interface ParsedCliArgs {
  cmd: string | undefined
  isBuiltin: boolean
  root: string
  dirArg: string | undefined
  flags: Map<string, string | true>
  positionals: string[]
  rawArgs: string[]
  pluginArgs: string[]
  error?: string | undefined
}

export function parseCliArgs(argv: readonly string[], cwd = process.cwd()): ParsedCliArgs {
  const cmd = argv[0]
  const rest = argv.slice(1)
  const isBuiltin = cmd !== undefined && BUILTIN_COMMANDS.has(cmd)
  const flags = new Map<string, string | true>()
  const positionals: string[] = []
  const pluginArgs: string[] = []

  if (!isBuiltin) {
    let rootFlag: string | undefined
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!
      if (arg === '--root') {
        const next = rest[i + 1]
        if (next === undefined || next.startsWith('-'))
          return { cmd, isBuiltin, root: resolve(cwd), dirArg: undefined, flags, positionals, rawArgs: [...rest], pluginArgs, error: 'kay: --root requires a directory path' }
        rootFlag = next
        i++
      }
      else if (arg.startsWith('--root=')) {
        rootFlag = arg.slice('--root='.length)
      }
      else {
        pluginArgs.push(arg)
        if (!arg.startsWith('-'))
          positionals.push(arg)
      }
    }
    return {
      cmd,
      isBuiltin,
      root: resolve(cwd, rootFlag ?? '.'),
      dirArg: undefined,
      flags,
      positionals,
      rawArgs: [...rest],
      pluginArgs,
    }
  }

  const allowed = ALLOWED_FLAGS_BY_CMD[cmd]!
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (!arg.startsWith('-')) {
      positionals.push(arg)
      continue
    }

    const eqIdx = arg.indexOf('=')
    const name = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg
    const inlineVal = eqIdx !== -1 ? arg.slice(eqIdx + 1) : undefined

    if (!allowed.has(name)) {
      return {
        cmd,
        isBuiltin,
        root: resolve(cwd),
        dirArg: positionals[0],
        flags,
        positionals,
        rawArgs: [...rest],
        pluginArgs,
        error: `kay ${cmd}: unknown option "${name}"`,
      }
    }

    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineVal !== undefined) {
        return {
          cmd,
          isBuiltin,
          root: resolve(cwd),
          dirArg: positionals[0],
          flags,
          positionals,
          rawArgs: [...rest],
          pluginArgs,
          error: `kay ${cmd}: option "${name}" does not take a value`,
        }
      }
      flags.set(name, true)
      continue
    }

    if (VALUE_FLAGS.has(name)) {
      if (inlineVal !== undefined) {
        flags.set(name, inlineVal)
      }
      else {
        const next = rest[i + 1]
        if (name === '--host' && (next === undefined || next.startsWith('-'))) {
          flags.set(name, '')
        }
        else if (next === undefined || next.startsWith('-')) {
          return {
            cmd,
            isBuiltin,
            root: resolve(cwd),
            dirArg: positionals[0],
            flags,
            positionals,
            rawArgs: [...rest],
            pluginArgs,
            error: `kay ${cmd}: option "${name}" requires a value`,
          }
        }
        else {
          flags.set(name, next)
          i++
        }
      }
      continue
    }

    if (OPTIONAL_VALUE_FLAGS.has(name)) {
      if (inlineVal !== undefined) {
        flags.set(name, inlineVal)
      }
      else {
        const next = rest[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          flags.set(name, next)
          i++
        }
        else {
          flags.set(name, true)
        }
      }
    }
  }

  const rootFlag = typeof flags.get('--root') === 'string' ? flags.get('--root') as string : undefined
  const dirArg = positionals[0]
  const root = resolve(cwd, rootFlag ?? dirArg ?? '.')

  return {
    cmd,
    isBuiltin,
    root,
    dirArg,
    flags,
    positionals,
    rawArgs: [...rest],
    pluginArgs,
  }
}

export interface RunCliOptions {
  cwd?: string | undefined
  stdout?: ((line: string) => void) | undefined
  stderr?: ((line: string) => void) | undefined
}

function resolveHostname(flags: ReadonlyMap<string, string | true>): string {
  const hostFlag = flags.get('--host')
  if (hostFlag !== undefined)
    return hostFlag === '' || hostFlag === true ? '0.0.0.0' : hostFlag
  return process.env.HOST || '127.0.0.1'
}

// `--max-js 40kb`, `--max-js 40KB` or `--max-js 40960` (bytes).
function parseSize(raw: string): number | undefined {
  const match = SIZE_RE.exec(raw.trim())
  if (match === null)
    return undefined
  return Math.round(Number(match[1]) * (match[2] === undefined ? 1 : 1024))
}

function parsePort(raw: string | number | true | undefined, fallback: number): { ok: true, port: number } | { ok: false, error: string } {
  if (raw === undefined || raw === '' || raw === true)
    return { ok: true, port: fallback }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535)
    return { ok: false, error: `kay: invalid port "${raw}" (expected an integer between 0 and 65535)` }
  return { ok: true, port: n }
}

const USAGE_TEXT = `Usage:
  kay new <dir> [--template minimal|fullstack|blog|app] [--force]
  kay check [dir] [--no-typecheck]
  kay dev [dir] [--port 3000] [--host [addr]]
  kay build [dir] [--static] [--compile [out]] [--analyze] [--max-js 40kb]
  kay start [dir] [--port 3000] [--host [addr]]
  kay upgrade [dir] [--no-install]`

export async function runCli(argv: readonly string[], options: RunCliOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd()
  const out = options.stdout ?? ((line: string) => console.log(line))
  const err = options.stderr ?? ((line: string) => console.error(line))

  const parsed = parseCliArgs(argv, cwd)
  if (parsed.error !== undefined) {
    err(parsed.error)
    return 1
  }

  const { cmd, root, dirArg, flags } = parsed

  if (cmd === undefined || cmd === '--help' || cmd === '-h' || flags.has('--help') || flags.has('-h')) {
    out(USAGE_TEXT)
    return 0
  }

  if (cmd === 'new') {
    if (!dirArg) {
      err('Usage: kay new <dir> [--template minimal|fullstack|blog|app] [--force]')
      return 1
    }
    const tpl = (typeof flags.get('--template') === 'string' ? flags.get('--template') as string : undefined) ?? 'minimal'
    if (!VALID_TEMPLATES.has(tpl)) {
      err(`kay new: unknown template "${tpl}" (use minimal, fullstack, blog, or app)`)
      return 1
    }
    const template = tpl as 'minimal' | 'fullstack' | 'blog' | 'app'
    const res = scaffoldProject(root, { template, force: flags.has('--force') })
    out(`Created Kay (${template}) project in ${res.root} (${res.files.length} files)`)
    out(`\nNext steps:\n  cd ${dirArg}\n  bun install\n  bun run dev`)
    return 0
  }

  if (cmd === 'check') {
    const t0 = performance.now()
    const res = await checkProject(root, { skipTypecheck: flags.has('--no-typecheck') })
    const ms = (performance.now() - t0).toFixed(1)
    for (const warning of res.warnings)
      console.warn(warning)
    if (res.ok) {
      out(`kay check passed (${res.checkedFiles} files) in ${ms} ms`)
      return 0
    }
    for (const e of res.errors)
      err(e)
    return 1
  }

  if (cmd === 'upgrade') {
    const res = upgradeProject(root)
    for (const file of res.changed)
      out(`  ${file}`)
    out(`kay upgrade rewrote ${res.changed.length} files`)
    if (res.changed.includes('package.json') && !flags.has('--no-install')) {
      const install = Bun.spawnSync(['bun', 'install'], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
      if (install.exitCode !== 0)
        return 1
    }
    for (const line of res.manual)
      err(line)
    if (res.manual.length > 0)
      return 1
    out('Next: kay check')
    return 0
  }

  if (cmd === 'build') {
    const isStatic = flags.has('--static')
    const analyze = flags.has('--analyze')
    const compileVal = flags.get('--compile')
    const compile = compileVal === undefined ? undefined : (compileVal === true || compileVal === '' ? true : compileVal)
    const maxJsVal = flags.get('--max-js')
    const maxJs = maxJsVal === undefined ? undefined : parseSize(String(maxJsVal))
    if (maxJsVal !== undefined && maxJs === undefined) {
      err(`kay: invalid --max-js "${maxJsVal}": give the gzipped size of a route's eager JS in bytes or KB, e.g. --max-js 40kb`)
      return 1
    }
    const t0 = performance.now()
    const manifest = await build({ root, static: isStatic, compile, analyze, maxJs })
    const ms = (performance.now() - t0).toFixed(1)
    out(`kay build done in ${ms} ms (${manifest.routes.length} routes, ${manifest.assets.length} client assets, ${manifest.actions.length} actions)`)
    return 0
  }

  if (cmd === 'start') {
    process.env.NODE_ENV ??= 'production'
    const config = await loadConfig(root)
    const portRes = parsePort(flags.get('--port') ?? (process.env.PORT || config.port), 3000)
    if (!portRes.ok) {
      err(portRes.error)
      return 1
    }
    const hostname = resolveHostname(flags)
    const app = await createServer({ root })
    const server = app.serve(portRes.port, hostname)
    handleSignals(app, server)
    out(`kay server listening on http://${hostname}:${server.port}`)
    return 0
  }

  if (cmd === 'dev') {
    let config: Awaited<ReturnType<typeof loadConfig>>
    try {
      config = await loadConfig(root)
    }
    catch (error) {
      err((error as Error).message)
      return 1
    }
    const portRes = parsePort(flags.get('--port') ?? (process.env.PORT || config.port), 3000)
    if (!portRes.ok) {
      err(portRes.error)
      return 1
    }
    const hostname = resolveHostname(flags)
    await devServer({ root, port: portRes.port, hostname })
    return 0
  }

  // Resolve plugin-registered CLI commands from kay.config.ts in `root` (cwd or `--root`)
  const config = await loadConfig(root)
  const pluginCmd = config.plugins
    ?.flatMap(p => Object.entries(p.commands ?? {}))
    .find(([name]) => name === cmd)?.[1]

  if (pluginCmd !== undefined) {
    await pluginCmd(parsed.pluginArgs, root)
    return 0
  }

  const pluginCmdNames = config.plugins?.flatMap(p => Object.keys(p.commands ?? {})) ?? []
  const extra = pluginCmdNames.length > 0 ? `\nPlugin commands:\n  ${pluginCmdNames.map(c => `kay ${c}`).join('\n  ')}` : ''
  err(`kay: unknown command "${cmd}"\n${USAGE_TEXT}${extra}`)
  return 1
}

if (import.meta.main) {
  const code = await runCli(Bun.argv.slice(2))
  if (code !== 0)
    process.exit(code)
}
