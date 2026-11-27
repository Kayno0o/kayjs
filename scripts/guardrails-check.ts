// Enforces architectural import boundaries, zero type-escape guardrails, and the empty-catch ratchet
// on `packages/*/src/**/*.{ts,tsx}` against scripts/guardrails-ratchet.json.

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, posix, resolve } from 'node:path'
import { fail, parse, runMain } from '@kaynooo/cli-kit'
import { Glob } from 'bun'

export type ViolationKind =
  | 'browser-pure-import'
  | 'cross-plugin-import'
  | 'no-as-any'
  | 'no-ts-directive'
  | 'empty-catch'

export interface GuardrailViolation {
  kind: ViolationKind
  file: string
  line?: number | undefined
  lines?: number[] | undefined
  detail: string
  fix: string
}

export interface RatchetShrink {
  kind: 'emptyCatches'
  file: string
  was: number
  now: number | undefined
}

export interface FileAnalysis {
  file: string
  violations: GuardrailViolation[]
  emptyCatchLines: number[]
}

export interface GuardrailsRatchet {
  emptyCatches: Record<string, number>
}

export interface GuardrailsReport {
  violations: GuardrailViolation[]
  shrinks: RatchetShrink[]
  fileCount: number
  emptyCatchCount: number
}

interface AstNode {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

interface CommentSpan {
  start: number
  end: number
}

interface OxcParserModule {
  parseSync: (
    filename: string,
    code: string,
    options: { lang: 'ts' | 'tsx', sourceType: 'module' },
  ) => {
    program: AstNode
    comments: CommentSpan[]
    errors: { message: string }[]
  }
  visitorKeys: Record<string, readonly string[]>
}

const requireFromKay = createRequire(new URL('../packages/kay/package.json', import.meta.url))
const { parseSync, visitorKeys } = requireFromKay('oxc-parser') as OxcParserModule

const ROOT = resolve(import.meta.dir, '..')
const DEFAULT_RATCHET = join(import.meta.dir, 'guardrails-ratchet.json')

const ALWAYS_FORBIDDEN_BROWSER_DIRS = new Set(['build', 'cli', 'dev'])
const TS_DIRECTIVE_RE = /@ts-(ignore|expect-error|nocheck)\b/g

function isAstNode(value: unknown): value is AstNode {
  return value !== null && typeof value === 'object' && typeof (value as AstNode).type === 'string'
}

function childEntries(node: AstNode): unknown[] {
  const keys = visitorKeys[node.type]
  const out: unknown[] = []
  if (keys !== undefined) {
    for (let i = 0; i < keys.length; i++) {
      const val = node[keys[i]!]
      if (val !== null && typeof val === 'object')
        out.push(val)
    }
    return out
  }
  for (const [key, val] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end')
      continue
    if (val !== null && typeof val === 'object')
      out.push(val)
  }
  return out
}

function buildLineStarts(code: string): number[] {
  const lineStarts = [0]
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10)
      lineStarts.push(i + 1)
  }
  return lineStarts
}

function offsetToLine(lineStarts: readonly number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid]! <= offset)
      lo = mid
    else
      hi = mid - 1
  }
  return lo + 1
}

function staticStringValue(node: unknown): string | undefined {
  if (!isAstNode(node))
    return undefined
  if (node.type === 'Literal' && typeof node.value === 'string')
    return node.value
  if (node.type === 'TemplateLiteral' && Array.isArray(node.expressions) && node.expressions.length === 0 && Array.isArray(node.quasis) && node.quasis.length === 1) {
    const quasi = node.quasis[0]
    if (isAstNode(quasi) && quasi.value !== null && typeof quasi.value === 'object') {
      const val = quasi.value as { cooked?: string | null, raw?: string }
      return val.cooked ?? val.raw
    }
  }
  return undefined
}

function isTypeOnlyImport(node: AstNode): boolean {
  if (node.importKind === 'type')
    return true
  if (Array.isArray(node.specifiers) && node.specifiers.length > 0)
    return node.specifiers.every(s => isAstNode(s) && s.importKind === 'type')
  return false
}

function isTypeOnlyExport(node: AstNode): boolean {
  if (node.exportKind === 'type')
    return true
  if (Array.isArray(node.specifiers) && node.specifiers.length > 0)
    return node.specifiers.every(s => isAstNode(s) && s.exportKind === 'type')
  return false
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')
}

export function isBrowserPureFile(file: string): boolean {
  return (
    file.startsWith('packages/kay/src/dom/')
    || file.startsWith('packages/kay/src/reactivity/')
    || file === 'packages/kay/src/context.ts'
  )
}

export function pluginPackageDir(file: string): string | undefined {
  const match = /^packages\/(plugin-[^/]+)\/src\//.exec(file)
  return match?.[1]
}

function defaultPluginPackageName(dir: string): string {
  return `@kayjs/${dir.slice('plugin-'.length)}`
}

function checkBrowserPureImport(
  file: string,
  specifier: string,
  typeOnly: boolean,
  line: number,
): GuardrailViolation | undefined {
  if (specifier === 'bun' || specifier.startsWith('bun:') || specifier.startsWith('node:')) {
    return {
      kind: 'browser-pure-import',
      file,
      line,
      detail: `browser-pure module imports "${specifier}"`,
      fix: 'keep browser-pure modules (dom/, reactivity/, context.ts) free of Node and Bun runtime imports',
    }
  }

  if (
    specifier === '@kayjs/kay/build'
    || specifier.startsWith('@kayjs/kay/build/')
    || specifier === '@kayjs/kay/internal/server'
    || specifier.startsWith('@kayjs/kay/internal/server/')
    || (!typeOnly && (specifier === '@kayjs/kay/server' || specifier.startsWith('@kayjs/kay/server/')))
  ) {
    return {
      kind: 'browser-pure-import',
      file,
      line,
      detail: `browser-pure module imports "${specifier}"`,
      fix: 'move shared pure helpers or types out of server/build modules before importing them in browser code',
    }
  }

  if (!isRelativeSpecifier(specifier))
    return undefined

  const resolved = posix.normalize(posix.join(posix.dirname(file), specifier))
  if (!resolved.startsWith('packages/kay/src/'))
    return undefined

  const topDir = resolved.slice('packages/kay/src/'.length).split('/')[0]
  if (topDir === undefined)
    return undefined

  if (ALWAYS_FORBIDDEN_BROWSER_DIRS.has(topDir) || (topDir === 'server' && !typeOnly)) {
    return {
      kind: 'browser-pure-import',
      file,
      line,
      detail: `browser-pure module imports "${specifier}" (resolves into ${topDir}/)`,
      fix: topDir === 'server'
        ? 'use `import type` for erased type-only contracts, or move shared runtime code out of server/'
        : `remove the ${topDir}/ dependency from browser-pure modules (dom/, reactivity/, context.ts)`,
    }
  }

  // Every client build that imports `@kayjs/kay` parses context.ts: reaching the DOM runtime from it cost bench-app's client build 4 ms (#3683).
  if (file === 'packages/kay/src/context.ts' && topDir === 'dom' && !typeOnly) {
    return {
      kind: 'browser-pure-import',
      file,
      line,
      detail: `context.ts imports "${specifier}", so every client build importing @kayjs/kay parses the DOM runtime`,
      fix: 'have the DOM compiler call the dom/ helper in place of the component, as it does for <Catch> with catchBoundary',
    }
  }

  return undefined
}

function checkCrossPluginImport(
  file: string,
  ownDir: string,
  ownPkgName: string,
  specifier: string,
  line: number,
): GuardrailViolation | undefined {
  if (specifier.startsWith('@kayjs/')) {
    const parts = specifier.split('/')
    const targetPkg = `${parts[0]}/${parts[1] ?? ''}`
    if (targetPkg !== '@kayjs/kay' && targetPkg !== ownPkgName) {
      return {
        kind: 'cross-plugin-import',
        file,
        line,
        detail: `plugin "${ownDir}" imports "${specifier}"`,
        fix: `communicate across plugins via @kayjs/kay/config service keys (packages/kay/src/plugins/services.ts) instead of importing ${targetPkg}`,
      }
    }
    return undefined
  }

  if (!isRelativeSpecifier(specifier))
    return undefined

  const resolved = posix.normalize(posix.join(posix.dirname(file), specifier))
  if (!resolved.startsWith('packages/'))
    return undefined

  const targetDir = resolved.split('/')[1]
  if (targetDir !== undefined && targetDir !== ownDir && (targetDir.startsWith('plugin-') || targetDir === 'ui')) {
    return {
      kind: 'cross-plugin-import',
      file,
      line,
      detail: `plugin "${ownDir}" imports "${specifier}" (resolves into packages/${targetDir}/)`,
      fix: `communicate across plugins via @kayjs/kay/config service keys (packages/kay/src/plugins/services.ts) instead of reaching into packages/${targetDir}`,
    }
  }

  return undefined
}

export function analyzeFile(
  filename: string,
  code: string,
  options?: { ownPackageName?: string | undefined },
): FileAnalysis {
  const file = filename.replaceAll('\\', '/')
  const lang = /\.[cm]?ts$/i.test(file) ? 'ts' : 'tsx'
  const parsed = parseSync(file, code, { lang, sourceType: 'module' })
  if (parsed.errors.length > 0)
    throw new Error(`guardrails-check: failed to parse ${file}: ${parsed.errors[0]!.message}`)

  const lineStarts = buildLineStarts(code)
  const violations: GuardrailViolation[] = []
  const emptyCatchLines: number[] = []
  const browserPure = isBrowserPureFile(file)
  const pluginDir = pluginPackageDir(file)
  const ownPkgName = pluginDir !== undefined
    ? (options?.ownPackageName ?? defaultPluginPackageName(pluginDir))
    : undefined

  // Check comments for @ts-ignore / @ts-expect-error / @ts-nocheck (ignores string literals).
  for (const comment of parsed.comments) {
    const text = code.slice(comment.start, comment.end)
    TS_DIRECTIVE_RE.lastIndex = 0
    for (let match = TS_DIRECTIVE_RE.exec(text); match !== null; match = TS_DIRECTIVE_RE.exec(text)) {
      const directive = `@ts-${match[1]!}`
      violations.push({
        kind: 'no-ts-directive',
        file,
        line: offsetToLine(lineStarts, comment.start + match.index),
        detail: `forbidden TypeScript suppression directive "${directive}"`,
        fix: `fix the underlying type error instead of suppressing TypeScript with ${directive}`,
      })
    }
  }

  const checkSpecifier = (specifier: string, typeOnly: boolean, offset: number): void => {
    const line = offsetToLine(lineStarts, offset)
    if (browserPure) {
      const violation = checkBrowserPureImport(file, specifier, typeOnly, line)
      if (violation !== undefined)
        violations.push(violation)
    }
    if (pluginDir !== undefined && ownPkgName !== undefined) {
      const violation = checkCrossPluginImport(file, pluginDir, ownPkgName, specifier, line)
      if (violation !== undefined)
        violations.push(violation)
    }
  }

  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object')
      return
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++)
        walk(value[i])
      return
    }
    if (!isAstNode(value))
      return

    if (value.type === 'ImportDeclaration') {
      const spec = staticStringValue(value.source)
      if (spec !== undefined)
        checkSpecifier(spec, isTypeOnlyImport(value), value.start)
    }
    else if (value.type === 'ExportNamedDeclaration' && value.source !== null && value.source !== undefined) {
      const spec = staticStringValue(value.source)
      if (spec !== undefined)
        checkSpecifier(spec, isTypeOnlyExport(value), value.start)
    }
    else if (value.type === 'ExportAllDeclaration') {
      const spec = staticStringValue(value.source)
      if (spec !== undefined)
        checkSpecifier(spec, value.exportKind === 'type', value.start)
    }
    else if (value.type === 'ImportExpression') {
      const spec = staticStringValue(value.source)
      if (spec !== undefined)
        checkSpecifier(spec, false, value.start)
    }
    else if (value.type === 'TSImportEqualsDeclaration' && isAstNode(value.moduleReference) && value.moduleReference.type === 'TSExternalModuleReference') {
      const spec = staticStringValue(value.moduleReference.expression)
      if (spec !== undefined)
        checkSpecifier(spec, value.importKind === 'type', value.start)
    }
    else if (
      value.type === 'CallExpression'
      && isAstNode(value.callee)
      && value.callee.type === 'Identifier'
      && value.callee.name === 'require'
      && Array.isArray(value.arguments)
      && value.arguments.length >= 1
    ) {
      const spec = staticStringValue(value.arguments[0])
      if (spec !== undefined)
        checkSpecifier(spec, false, value.start)
    }
    else if (
      (value.type === 'TSAsExpression' || value.type === 'TSTypeAssertion')
      && isAstNode(value.typeAnnotation)
      && value.typeAnnotation.type === 'TSAnyKeyword'
    ) {
      violations.push({
        kind: 'no-as-any',
        file,
        line: offsetToLine(lineStarts, value.start),
        detail: value.type === 'TSAsExpression' ? 'forbidden `as any` type escape' : 'forbidden `<any>` type escape',
        fix: 'replace with `unknown` and narrow, or use a concrete type',
      })
    }
    else if (
      value.type === 'CatchClause'
      && isAstNode(value.body)
      && value.body.type === 'BlockStatement'
      && Array.isArray(value.body.body)
      && value.body.body.length === 0
    ) {
      emptyCatchLines.push(offsetToLine(lineStarts, value.start))
    }

    const children = childEntries(value)
    for (let i = 0; i < children.length; i++)
      walk(children[i])
  }

  walk(parsed.program)
  return { file, violations, emptyCatchLines }
}

async function readPluginPackageNames(root: string): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  for await (const rel of new Glob('packages/plugin-*/package.json').scan(root)) {
    const dir = rel.replaceAll('\\', '/').split('/')[1]
    if (dir === undefined)
      continue
    const data = (await Bun.file(join(root, rel)).json()) as { name?: unknown }
    if (typeof data.name === 'string' && data.name.length > 0)
      names.set(dir, data.name)
  }
  return names
}

export async function scanProject(root: string): Promise<FileAnalysis[]> {
  const files: string[] = []
  for await (const rel of new Glob('packages/*/src/**/*.{ts,tsx}').scan(root))
    files.push(rel.replaceAll('\\', '/'))
  files.sort()

  const pluginNames = await readPluginPackageNames(root)
  const results: FileAnalysis[] = []
  for (const rel of files) {
    const code = await Bun.file(join(root, rel)).text()
    const pluginDir = pluginPackageDir(rel)
    const ownPackageName = pluginDir !== undefined ? pluginNames.get(pluginDir) : undefined
    results.push(analyzeFile(rel, code, { ownPackageName }))
  }
  return results
}

function sortRecord(entries: [string, number][]): Record<string, number> {
  entries.sort((a, b) => a[0].localeCompare(b[0]))
  return Object.fromEntries(entries)
}

export function buildRatchet(analyses: readonly FileAnalysis[]): GuardrailsRatchet {
  const emptyCatches: [string, number][] = []
  for (const a of analyses) {
    if (a.emptyCatchLines.length > 0)
      emptyCatches.push([a.file, a.emptyCatchLines.length])
  }
  return { emptyCatches: sortRecord(emptyCatches) }
}

export function checkAnalyses(analyses: readonly FileAnalysis[], ratchet: GuardrailsRatchet): GuardrailsReport {
  const violations: GuardrailViolation[] = []
  const shrinks: RatchetShrink[] = []
  const seenFiles = new Set<string>()
  let emptyCatchCount = 0

  for (const a of analyses) {
    seenFiles.add(a.file)
    for (const v of a.violations)
      violations.push(v)

    const count = a.emptyCatchLines.length
    emptyCatchCount += count
    const recorded = ratchet.emptyCatches[a.file]
    const cap = recorded ?? 0

    if (count > cap) {
      const capText = recorded !== undefined ? `ratchet ${cap}, limit 0` : 'limit 0'
      const lineList = a.emptyCatchLines.join(', ')
      const noun = count === 1 ? 'empty catch block' : 'empty catch blocks'
      violations.push({
        kind: 'empty-catch',
        file: a.file,
        lines: a.emptyCatchLines,
        detail: `${count} ${noun} at line${a.emptyCatchLines.length === 1 ? '' : 's'} ${lineList} (${capText})`,
        fix: 'handle, log, rethrow, or return a fallback instead of swallowing errors',
      })
    }
    else if (recorded !== undefined && count < recorded) {
      shrinks.push({ kind: 'emptyCatches', file: a.file, was: recorded, now: count })
    }
  }

  for (const [file, was] of Object.entries(ratchet.emptyCatches)) {
    if (!seenFiles.has(file))
      shrinks.push({ kind: 'emptyCatches', file, was, now: undefined })
  }

  return { violations, shrinks, fileCount: analyses.length, emptyCatchCount }
}

export function formatViolation(v: GuardrailViolation): string {
  const loc = v.line !== undefined ? `${v.file}:${v.line}` : v.file
  return `[${v.kind}] ${loc}: ${v.detail} — ${v.fix}`
}

function formatShrink(s: RatchetShrink): string {
  if (s.now === undefined)
    return `${s.file}: removed (was ${s.was} empty catch${s.was === 1 ? '' : 'es'})`
  return `${s.file}: ${s.was} -> ${s.now} empty catch${s.now === 1 ? '' : 'es'}`
}

async function readRatchet(path: string): Promise<GuardrailsRatchet> {
  if (!existsSync(path))
    return { emptyCatches: {} }
  const data = (await Bun.file(path).json()) as Partial<GuardrailsRatchet>
  return { emptyCatches: data.emptyCatches ?? {} }
}

const USAGE = 'bun scripts/guardrails-check.ts [options]: enforces import boundaries, type-escape rules, and the empty-catch ratchet on packages/*/src/**/*.{ts,tsx}'

if (import.meta.main) {
  process.exitCode = await runMain({
    name: 'guardrails-check',
    usage: false,
    run: async (args) => {
      const { values } = parse(args, USAGE, {
        update: { type: 'boolean', description: 'recompute scripts/guardrails-ratchet.json from the current tree (lowers or removes shrunk empty-catch entries)' },
        root: { type: 'string', description: 'project root to scan (defaults to the repository root)' },
        ratchet: { type: 'string', description: 'path to the ratchet JSON file (defaults to scripts/guardrails-ratchet.json)' },
      }, { exits: [[0, 'all guardrails passed'], [1, 'one or more guardrail violations found'], [2, 'a usage error']] })

      const root = values.root !== undefined ? resolve(values.root) : ROOT
      const ratchetPath = values.ratchet !== undefined
        ? resolve(values.ratchet)
        : (values.root !== undefined ? join(root, 'scripts/guardrails-ratchet.json') : DEFAULT_RATCHET)
      const analyses = await scanProject(root)

      if (values.update === true) {
        const next = buildRatchet(analyses)
        await Bun.write(ratchetPath, `${JSON.stringify(next, null, 2)}\n`)
        const rel = ratchetPath.startsWith(`${root}/`) ? ratchetPath.slice(root.length + 1) : ratchetPath
        const total = Object.values(next.emptyCatches).reduce((sum, n) => sum + n, 0)
        console.log(`wrote ${rel} (${Object.keys(next.emptyCatches).length} files, ${total} empty catches)`)
        return 0
      }

      const ratchet = await readRatchet(ratchetPath)
      const report = checkAnalyses(analyses, ratchet)

      if (report.shrinks.length > 0) {
        console.log(`ratchet can be lowered for ${report.shrinks.length} entr${report.shrinks.length === 1 ? 'y' : 'ies'} (run \`bun scripts/guardrails-check.ts --update\`):`)
        for (const s of report.shrinks)
          console.log(`  - ${formatShrink(s)}`)
      }

      if (report.violations.length > 0) {
        for (const v of report.violations)
          console.error(`  ✗ ${formatViolation(v)}`)
        return fail(
          `${report.violations.length} guardrail violation${report.violations.length === 1 ? '' : 's'}`,
          1,
          'fix the offending import, type escape, or empty catch; if an existing empty catch was removed, run `bun scripts/guardrails-check.ts --update`',
        )
      }

      console.log(`✓ guardrails ok (${report.fileCount} files, ${report.emptyCatchCount} ratcheted empty catches)`)
      return 0
    },
  })
}
