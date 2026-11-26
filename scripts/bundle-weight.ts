// Real-app bundle weight report across bench-app, examples/noticeboard, and docs.
// Usage: bun scripts/bundle-weight.ts

import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from '@kayjs/kay/build'

const ROOT = resolve(import.meta.dir, '..')
const APPS = [
  { name: 'bench-app', dir: join(ROOT, 'bench-app') },
  { name: 'examples/noticeboard', dir: join(ROOT, 'examples/noticeboard') },
  { name: 'docs', dir: join(ROOT, 'docs') },
]

for (const app of APPS) {
  if (!existsSync(app.dir))
    continue
  const outDir = '.kay-weight-tmp'
  console.log(`\n>>> ${app.name}`)
  try {
    await build({ root: app.dir, outDir, minify: true, prerender: false, copyPublic: false, analyze: true })
  }
  finally {
    rmSync(join(app.dir, outDir), { recursive: true, force: true })
  }
}
