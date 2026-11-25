#!/usr/bin/env bun
// Kay v2 minimal CLI: `kay new`, `kay check`, `kay dev`, `kay build [--static] [--compile [out]]`, `kay start`.

import { resolve } from 'node:path'
import { build } from '../build/index'
import { devServer } from '../dev/index'
import { loadConfig } from '../plugins/index'
import { createServer } from '../server/index'
import { checkProject } from './check'
import { scaffoldProject } from './new'

const args = Bun.argv.slice(2)
const cmd = args[0]

const BUILTIN_COMMANDS = new Set(['new', 'check', 'build', 'start', 'dev'])
const VALID_TEMPLATES = new Set(['minimal', 'fullstack', 'blog', 'app'])

function flagValue(name: string): string | undefined {
  const prefix = `${name}=`
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith(prefix))
      return a.slice(prefix.length)
    if (a === name) {
      const next = args[i + 1]
      return next !== undefined && !next.startsWith('-') ? next : ''
    }
  }
  return undefined
}

function hasFlag(name: string): boolean {
  return args.includes(name)
}

function resolveHostname(): string {
  const hostFlag = flagValue('--host')
  if (hostFlag !== undefined)
    return hostFlag === '' ? '0.0.0.0' : hostFlag
  return process.env.HOST || '127.0.0.1'
}

function parsePort(raw: string | number | undefined, fallback: number): number {
  if (raw === undefined || raw === '')
    return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`kay: invalid port "${raw}" (expected an integer between 0 and 65535)`)
    process.exit(1)
  }
  return n
}

const dirArg = cmd !== undefined && BUILTIN_COMMANDS.has(cmd)
  ? args.slice(1).find((a, i, arr) => {
      if (a.startsWith('-'))
        return false
      const prev = arr[i - 1]
      if (prev === '--port' || prev === '--host' || prev === '--compile' || prev === '--template')
        return false
      return true
    })
  : undefined
const root = resolve(dirArg ?? process.cwd())

if (cmd === 'new') {
  if (!dirArg) {
    console.error('Usage: kay new <dir> [--template minimal|fullstack|blog|app] [--force]')
    process.exit(1)
  }
  const tpl = flagValue('--template') ?? 'minimal'
  if (!VALID_TEMPLATES.has(tpl)) {
    console.error(`kay new: unknown template "${tpl}" (use minimal, fullstack, blog, or app)`)
    process.exit(1)
  }
  const template = tpl as 'minimal' | 'fullstack' | 'blog' | 'app'
  const res = scaffoldProject(root, { template, force: hasFlag('--force') })
  console.log(`Created Kay (${template}) project in ${res.root} (${res.files.length} files)`)
  console.log(`\nNext steps:\n  cd ${dirArg}\n  bun install\n  bun run dev`)
}
else if (cmd === 'check') {
  const t0 = performance.now()
  const res = await checkProject(root, { skipTypecheck: hasFlag('--no-typecheck') })
  const ms = (performance.now() - t0).toFixed(1)
  for (const warning of res.warnings)
    console.warn(warning)
  if (res.ok) {
    console.log(`kay check passed (${res.checkedFiles} files) in ${ms} ms`)
  }
  else {
    for (const err of res.errors)
      console.error(err)
    process.exit(1)
  }
}
else if (cmd === 'build') {
  const isStatic = hasFlag('--static')
  const analyze = hasFlag('--analyze')
  const compileFlag = flagValue('--compile')
  const compile = compileFlag === undefined ? undefined : (compileFlag === '' ? true : compileFlag)
  const t0 = performance.now()
  const manifest = await build({ root, static: isStatic, compile, analyze })
  const ms = (performance.now() - t0).toFixed(1)
  console.log(`kay build done in ${ms} ms (${manifest.routes.length} routes, ${manifest.assets.length} client assets, ${manifest.actions.length} actions)`)
}
else if (cmd === 'start') {
  process.env.NODE_ENV ??= 'production'
  const config = await loadConfig(root)
  const port = parsePort(flagValue('--port') || process.env.PORT || config.port, 3000)
  const hostname = resolveHostname()
  const app = await createServer({ root })
  const server = app.serve(port, hostname)
  console.log(`kay server listening on http://${hostname}:${server.port}`)
}
else if (cmd === 'dev') {
  const config = await loadConfig(root).catch(() => ({} as Awaited<ReturnType<typeof loadConfig>>))
  const port = parsePort(flagValue('--port') || process.env.PORT || config.port, 3000)
  const hostname = resolveHostname()
  await devServer({ root, port, hostname })
}
else {
  // Check plugin-registered CLI commands from kay.config.ts in current working directory
  const config = await loadConfig(process.cwd())
  const pluginCmd = cmd !== undefined
    ? config.plugins?.flatMap(p => Object.entries(p.commands ?? {})).find(([name]) => name === cmd)?.[1]
    : undefined

  if (pluginCmd !== undefined) {
    await pluginCmd(args.slice(1), process.cwd())
  }
  else {
    console.log(`Usage: kay <command> [dir] [options]

Commands:
  kay new <dir> [--template minimal|fullstack|blog|app] [--force]
                                       Scaffold a new Kay project
  kay check [dir]                      Validate routes, compiler rules, and TypeScript types
  kay dev [dir] [--port 3000] [--host [addr]]
                                       Run dev server with fast reload (binds 127.0.0.1 by default)
  kay build [dir] [--static] [--compile [out]]
                                       Build production app, static site, or single executable
  kay start [dir] [--port 3000] [--host [addr]]
                                       Serve the built production app (binds 127.0.0.1 by default)`)
    process.exit(cmd === '--help' || cmd === '-h' || cmd === undefined ? 0 : 1)
  }
}
