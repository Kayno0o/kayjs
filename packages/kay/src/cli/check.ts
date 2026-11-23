// `kay check [dir]`: validates routes, Kay compiler rules, config, and runs TypeScript type-checking.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { analyzeModule } from '../compiler/index'
import { loadConfig } from '../plugins/index'

export interface CheckResult {
  ok: boolean
  checkedFiles: number
  errors: string[]
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir))
    return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.'))
        continue
      walkTsFiles(full, out)
    }
    else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

export async function checkProject(rootDir: string, options: { skipTypecheck?: boolean } = {}): Promise<CheckResult> {
  const root = resolve(rootDir)
  const errors: string[] = []

  // 1. Validate kay.config.ts
  let routesDir = resolve(root, 'src/routes')
  try {
    const cfg = await loadConfig(root)
    if (cfg.routesDir !== undefined)
      routesDir = resolve(root, cfg.routesDir)
  }
  catch (err) {
    errors.push(`kay.config.ts: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2. Validate routesDir exists
  if (!existsSync(routesDir))
    errors.push(`missing routes directory: ${relative(root, routesDir) || routesDir}`)

  // 3. Parse & run Kay static compiler analysis across src/
  const srcDir = resolve(root, 'src')
  const files = walkTsFiles(existsSync(srcDir) ? srcDir : routesDir)
  for (const file of files) {
    try {
      const code = readFileSync(file, 'utf8')
      analyzeModule(file, code)
    }
    catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  // 4. Run TypeScript check (`tsgo` preferred, fallback to `tsc`) when tsconfig.json exists
  const tsconfigPath = join(root, 'tsconfig.json')
  if (!options.skipTypecheck && existsSync(tsconfigPath)) {
    const candidates = [
      join(root, 'node_modules/.bin/tsgo'),
      join(root, 'node_modules/.bin/tsc'),
      'tsgo',
      'tsc',
    ]
    let bin: string | undefined
    for (const c of candidates) {
      if (c.includes('/') ? existsSync(c) : Bun.which(c) !== null) {
        bin = c
        break
      }
    }
    if (bin !== undefined) {
      const proc = Bun.spawnSync([bin, '--noEmit', '-p', tsconfigPath], { cwd: root })
      if (proc.exitCode !== 0) {
        const out = (proc.stdout.toString() + proc.stderr.toString()).trim()
        errors.push(out || `${bin} exited with code ${proc.exitCode}`)
      }
    }
  }

  return { ok: errors.length === 0, checkedFiles: files.length, errors }
}
