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

function flagValue(name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx === -1)
    return undefined
  const next = args[idx + 1]
  return next !== undefined && !next.startsWith('-') ? next : ''
}

function hasFlag(name: string): boolean {
  return args.includes(name)
}

const dirArg = args.slice(1).find((a, i, arr) => {
  if (a.startsWith('-'))
    return false
  const prev = arr[i - 1]
  if (prev === '--port' || prev === '--compile' || prev === '--template')
    return false
  return true
})
const root = resolve(dirArg ?? process.cwd())

if (cmd === 'new') {
  if (!dirArg) {
    console.error('Usage: kay new <dir> [--template minimal|fullstack] [--force]')
    process.exit(1)
  }
  const tpl = flagValue('--template')
  const template = tpl === 'fullstack' ? 'fullstack' : 'minimal'
  const res = scaffoldProject(root, { template, force: hasFlag('--force') })
  console.log(`Created Kay (${template}) project in ${res.root} (${res.files.length} files)`)
  console.log(`\nNext steps:\n  cd ${dirArg}\n  bun install\n  bun run dev`)
}
else if (cmd === 'check') {
  const t0 = performance.now()
  const res = await checkProject(root, { skipTypecheck: hasFlag('--no-typecheck') })
  const ms = (performance.now() - t0).toFixed(1)
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
  const compileFlag = flagValue('--compile')
  const compile = compileFlag === undefined ? undefined : (compileFlag === '' ? true : compileFlag)
  const t0 = performance.now()
  const manifest = await build({ root, static: isStatic, compile })
  const ms = (performance.now() - t0).toFixed(1)
  console.log(`kay build done in ${ms} ms (${manifest.routes.length} routes, ${manifest.assets.length} client assets, ${manifest.actions.length} actions)`)
}
else if (cmd === 'start') {
  const port = Number(flagValue('--port') || process.env.PORT || 3000)
  const app = await createServer({ root })
  const server = app.serve(port)
  console.log(`kay server listening on http://localhost:${server.port}`)
}
else if (cmd === 'dev') {
  const port = Number(flagValue('--port') || process.env.PORT || 3000)
  await devServer({ root, port })
}
else {
  // Check plugin-registered CLI commands from kay.config.ts
  const config = await loadConfig(root)
  const pluginCmd = cmd !== undefined
    ? config.plugins?.flatMap(p => Object.entries(p.commands ?? {})).find(([name]) => name === cmd)?.[1]
    : undefined

  if (pluginCmd !== undefined) {
    await pluginCmd(args.slice(1), root)
  }
  else {
    console.log(`Usage: kay <command> [dir] [options]

Commands:
  kay new <dir> [--template minimal|fullstack] [--force]
                                       Scaffold a new Kay project
  kay check [dir]                      Validate routes, compiler rules, and TypeScript types
  kay dev [dir] [--port 3000]          Run dev server with fast reload
  kay build [dir] [--static] [--compile [out]]
                                       Build production app, static site, or single executable
  kay start [dir] [--port 3000]        Serve the built production app`)
    process.exit(cmd === '--help' || cmd === '-h' || cmd === undefined ? 0 : 1)
  }
}
