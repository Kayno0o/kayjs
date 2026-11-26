import type { TaskDefinition, TaskSpec } from './types'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import kayPkg from '../../packages/kay/package.json' with { type: 'json' }
import { scaffoldProject } from '../../packages/kay/src/cli/new'

export const REPO_ROOT = resolve(import.meta.dir, '../..')
export const PACKAGES_DIR = join(REPO_ROOT, 'packages')
export const KAY_CLI_ENTRY = join(PACKAGES_DIR, 'kay/src/cli/index.ts')

export const WORKSPACE_PACKAGES: Record<string, string> = {
  kay: 'kay',
  auth: 'plugin-auth',
  content: 'plugin-content',
  i18n: 'plugin-i18n',
  icons: 'plugin-icons',
  images: 'plugin-images',
  live: 'plugin-live',
  mail: 'plugin-mail',
  mcp: 'plugin-mcp',
  seo: 'plugin-seo',
  spa: 'plugin-spa',
  tailwind: 'plugin-tailwind',
  ui: 'ui',
}

const SIZE_RE = /^(\d+(?:\.\d+)?)\s*(kb|b)?$/i

export function parseSizeBytes(raw: string): number {
  const match = SIZE_RE.exec(raw.trim())
  if (match === null)
    throw new Error(`evals: invalid size "${raw}" (expected e.g. "0kb", "15kb", or "4096")`)
  const unit = match[2]?.toLowerCase()
  const mult = unit === 'kb' ? 1024 : 1
  return Math.round(Number(match[1]) * mult)
}

function replaceSymlink(target: string, linkPath: string, type: 'dir' | 'file' = 'dir'): void {
  if (existsSync(linkPath) || isDanglingSymlink(linkPath))
    rmSync(linkPath, { recursive: true, force: true })
  symlinkSync(target, linkPath, type)
}

function isDanglingSymlink(path: string): boolean {
  try {
    lstatSync(path)
    return true
  }
  catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/**
 * Links all local `@kayjs/*` workspace packages and monorepo dev tooling (`@types`,
 * `typescript`, `@kaynooo`, `oxc-parser`, `.bin/kay`, `.bin/tsc`) into `destDir/node_modules`.
 */
export function linkWorkspacePackages(destDir: string): void {
  const root = resolve(destDir)
  const nm = join(root, 'node_modules')
  const kayScope = join(nm, '@kayjs')
  const binDir = join(nm, '.bin')
  mkdirSync(kayScope, { recursive: true })
  mkdirSync(binDir, { recursive: true })

  for (const [pkgName, folder] of Object.entries(WORKSPACE_PACKAGES)) {
    const src = join(PACKAGES_DIR, folder)
    if (existsSync(src))
      replaceSymlink(src, join(kayScope, pkgName), 'dir')
  }

  const rootNm = join(REPO_ROOT, 'node_modules')
  for (const dep of ['@types', '@kaynooo', 'typescript', 'oxc-parser']) {
    const src = join(rootNm, dep)
    if (existsSync(src))
      replaceSymlink(src, join(nm, dep), 'dir')
  }

  replaceSymlink(KAY_CLI_ENTRY, join(binDir, 'kay'), 'file')
  const rootTsc = join(rootNm, '.bin/tsc')
  if (existsSync(rootTsc))
    replaceSymlink(rootTsc, join(binDir, 'tsc'), 'file')
}

function syncPackageDependencies(destDir: string, spec: TaskSpec): void {
  const pkgPath = join(destDir, 'package.json')
  if (!existsSync(pkgPath))
    return
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>
    [k: string]: unknown
  }
  const deps: Record<string, string> = { ...(pkg.dependencies ?? {}) }
  const version = `^${kayPkg.version}`
  for (const name of spec.packages)
    deps[name] = deps[name] ?? version
  pkg.dependencies = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
}

export interface InitWorkspaceResult {
  dir: string
  task: TaskSpec
  promptPath: string
  files: string[]
}

export function initTaskWorkspace(
  task: TaskDefinition,
  destDir: string,
  options: { force?: boolean } = {},
): InitWorkspaceResult {
  const root = resolve(destDir)
  const scaffolded = scaffoldProject(root, {
    template: task.spec.template,
    force: options.force,
    kayVersion: `^${kayPkg.version}`,
  })
  syncPackageDependencies(root, task.spec)
  linkWorkspacePackages(root)
  const copiedPrompt = join(root, 'TASK.md')
  copyFileSync(task.promptPath, copiedPrompt)
  return {
    dir: root,
    task: task.spec,
    promptPath: copiedPrompt,
    files: [...scaffolded.files, 'TASK.md'],
  }
}
