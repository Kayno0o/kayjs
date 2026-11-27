// File-system helpers of the build: directory walks and the outDir safety check.

import type { Dirent } from 'node:fs'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isInside } from './is-inside'

const TEST_FILE_RE = /\.(?:test|spec)\.(?:tsx|ts)$/
const BACKSLASH_RE = /\\/g
const NODE_MODULES_RE = /[\\/]node_modules[\\/]/

/** `relative(from, to)` with forward slashes, the form manifests and messages use. */
export function relPosix(from: string, to: string): string {
  return relative(from, to).replace(BACKSLASH_RE, '/')
}

/** Whether `file` sits under a `node_modules` folder, with either path separator. */
export function isInNodeModules(file: string): boolean {
  return NODE_MODULES_RE.test(file)
}

export function isTsFile(file: string): boolean {
  return file.endsWith('.tsx') || file.endsWith('.ts')
}

/** The size of a file in bytes, or undefined when it does not exist. */
export function fileSize(file: string): number | undefined {
  try {
    return statSync(file).size
  }
  catch {
    return undefined
  }
}

interface WalkOptions {
  skipDir?: (name: string) => boolean
  keep?: (entry: Dirent) => boolean
}

/** Every kept file under `dir`, depth first; a missing `dir` is empty. */
export function walkFiles(dir: string, options: WalkOptions = {}, out: string[] = []): string[] {
  if (!existsSync(dir))
    return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (options.skipDir?.(entry.name) !== true)
        walkFiles(full, options, out)
    }
    else if (options.keep === undefined || options.keep(entry)) {
      out.push(full)
    }
  }
  return out
}

/** Route sources: `.ts`/`.tsx` outside `_`-prefixed folders, without declarations and tests. */
export function walkRoutes(dir: string): string[] {
  return walkFiles(dir, {
    skipDir: name => name.startsWith('_'),
    keep: entry => isTsFile(entry.name) && !entry.name.endsWith('.d.ts') && !TEST_FILE_RE.test(entry.name),
  })
}

/** Folders that never hold an app's own source: its dependencies, its build, and dot folders such as `.git` and `.kay-cache`. */
export function isNotSourceDir(name: string): boolean {
  return name === 'node_modules' || name === 'dist' || name.startsWith('.')
}

export function walkAllFiles(dir: string): string[] {
  return walkFiles(dir, { keep: entry => entry.isFile() })
}


export function assertSafeOutDir(root: string, outDir: string, routesDir: string, publicDir: string): void {
  // Refuse filesystem root, home dir, tmpdir root, or root/ancestors of root
  if (dirname(outDir) === outDir || outDir === tmpdir() || outDir === resolve(process.env.HOME ?? '\0')) {
    throw new Error(`kay build: refusing unsafe outDir "${outDir}" — cannot wipe a root or shared system directory.`)
  }
  if (isInside(outDir, root, { orSame: true })) {
    throw new Error(`kay build: refusing unsafe outDir "${outDir}" — outDir cannot be or contain project root "${root}".`)
  }
  if (existsSync(outDir)) {
    try {
      const realRoot = realpathSync(root)
      const realOut = realpathSync(outDir)
      if (dirname(realOut) === realOut || isInside(realOut, realRoot, { orSame: true })) {
        throw new Error(`kay build: refusing unsafe outDir "${outDir}" — resolved target "${realOut}" is or contains project root "${realRoot}".`)
      }
    }
    catch (err) {
      if (err instanceof Error && err.message.startsWith('kay build: refusing unsafe outDir'))
        throw err
    }
  }
  const protectedTargets: [string, string][] = [
    ['src', resolve(root, 'src')],
    ['routesDir', routesDir],
    ['publicDir', publicDir],
    ['kay.config.ts', resolve(root, 'kay.config.ts')],
    ['package.json', resolve(root, 'package.json')],
  ]
  for (const [label, target] of protectedTargets) {
    if (isInside(outDir, target, { orSame: true })) {
      throw new Error(`kay build: refusing unsafe outDir "${outDir}" — it equals or contains protected path ${label} ("${target}").`)
    }
  }
  // If outDir is outside root (e.g. an external temp build dir), refuse it if it looks like another project directory.
  if (!isInside(root, outDir) && existsSync(outDir)) {
    for (const marker of ['package.json', 'kay.config.ts', 'src']) {
      if (existsSync(join(outDir, marker))) {
        throw new Error(`kay build: refusing unsafe external outDir "${outDir}" — it contains "${marker}".`)
      }
    }
  }
}

export interface BunBuildLogLike {
  message?: string | undefined
  level?: string | undefined
  position?: {
    file?: string | undefined
    line?: number | undefined
    column?: number | undefined
    length?: number | undefined
    lineText?: string | undefined
  } | null | undefined
}

/** Formats Bun `BuildMessage` / `ResolveMessage` logs with `file:line:col: error|warning: <message>` and a source line frame. */
export function formatBunBuildLogs(logs: readonly unknown[], root?: string): string {
  return logs.map((raw) => {
    if (raw === null || typeof raw !== 'object')
      return String(raw)
    const log = raw as BunBuildLogLike
    const msg = typeof log.message === 'string' && log.message.length > 0 ? log.message : String(raw)
    const pos = log.position
    if (pos && typeof pos.file === 'string' && pos.file.length > 0 && typeof pos.line === 'number') {
      const file = root !== undefined && isAbsolute(pos.file) ? relPosix(root, pos.file) : pos.file
      const col = typeof pos.column === 'number' && pos.column > 0 ? pos.column : 1
      const severity = log.level === 'warning' ? 'warning' : 'error'
      const header = `${file}:${pos.line}:${col}: ${severity}: ${msg}`
      if (typeof pos.lineText === 'string') {
        const lineStr = String(pos.line)
        const pad = ' '.repeat(lineStr.length)
        const maxSpan = Math.max(1, pos.lineText.length - (col - 1))
        const len = typeof pos.length === 'number' && pos.length > 0 ? Math.min(pos.length, maxSpan) : 1
        return `${header}\n  ${lineStr} | ${pos.lineText}\n  ${pad} | ${' '.repeat(Math.max(0, col - 1))}${'^'.repeat(len)}`
      }
      return header
    }
    return msg
  }).join('\n')
}
