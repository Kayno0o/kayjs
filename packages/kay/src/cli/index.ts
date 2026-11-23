#!/usr/bin/env bun
// Kay v2 minimal CLI: `kay dev`, `kay build [--static] [--compile [out]]`, `kay start`.

import { resolve } from 'node:path'
import { build } from '../build/index'
import { devServer } from '../dev/index'
import { createServer } from '../server/index'

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

const dirArg = args.slice(1).find(a => !a.startsWith('-'))
const root = resolve(dirArg ?? process.cwd())

if (cmd === 'build') {
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
  console.log(`Usage: kay <command> [dir] [options]

Commands:
  kay dev [dir] [--port 3000]          Run dev server with fast reload
  kay build [dir] [--static] [--compile [out]]
                                       Build production app, static site, or single executable
  kay start [dir] [--port 3000]        Serve the built production app`)
  process.exit(cmd === '--help' || cmd === '-h' || cmd === undefined ? 0 : 1)
}
