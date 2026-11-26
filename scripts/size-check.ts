// Enforces the AGENTS.md size and complexity caps on `packages/*/src/**/*.{ts,tsx}`,
// holding pre-existing over-cap files and functions to their ratchet in scripts/size-ratchet.json.

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fail, parse, runMain } from '@kaynooo/cli-kit'
import { Glob } from 'bun'

export const MAX_FILE_LINES = 600
export const MAX_FN_LINES = 150
export const MAX_FN_COMPLEXITY = 40

export interface FunctionMetric {
  key: string
  lines: number
  complexity: number
  line: number
}

export interface FileMetrics {
  file: string
  lines: number
  functions: FunctionMetric[]
}

export interface SizeRatchet {
  files: Record<string, number>
  functionLines: Record<string, number>
  functionComplexity: Record<string, number>
}

export type MetricKind = 'file' | 'functionLines' | 'functionComplexity'

export interface CheckViolation {
  kind: MetricKind
  key: string
  value: number
  cap: number
  limit: number
  ratcheted: boolean
}

export interface CheckShrink {
  kind: MetricKind
  key: string
  was: number
  now: number | undefined
}

export interface CheckReport {
  violations: CheckViolation[]
  shrinks: CheckShrink[]
  fileCount: number
  functionCount: number
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
const DEFAULT_RATCHET = join(import.meta.dir, 'size-ratchet.json')

const BRANCH_NODES = new Set([
  'IfStatement',
  'ConditionalExpression',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'CatchClause',
])

const NESTED_BOUNDARY = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'MethodDefinition',
  'StaticBlock',
])

const TRANSPARENT_PARENTS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'ParenthesizedExpression',
])

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

function stripComments(code: string, comments: readonly CommentSpan[]): string {
  if (comments.length === 0)
    return code
  let out = ''
  let cursor = 0
  for (const c of comments) {
    if (c.start < cursor)
      continue
    out += code.slice(cursor, c.start)
    out += code.slice(c.start, c.end).replace(/[^\r\n]/g, ' ')
    cursor = c.end
  }
  out += code.slice(cursor)
  return out
}

function buildLineIndex(code: string, comments: readonly CommentSpan[]): {
  lineStarts: number[]
  codePrefix: Int32Array
} {
  const lineStarts = [0]
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10)
      lineStarts.push(i + 1)
  }
  const lines = stripComments(code, comments).split('\n')
  const codePrefix = new Int32Array(lines.length + 1)
  for (let i = 0; i < lines.length; i++)
    codePrefix[i + 1] = codePrefix[i]! + (lines[i]!.trim().length > 0 ? 1 : 0)
  return { lineStarts, codePrefix }
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
  return lo
}

function keyName(node: unknown): string | undefined {
  if (!isAstNode(node))
    return undefined
  if (node.type === 'Identifier' || node.type === 'PrivateIdentifier')
    return String(node.name)
  if (node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number'))
    return String(node.value)
  return undefined
}

function exprName(node: unknown): string | undefined {
  if (!isAstNode(node))
    return undefined
  if (node.type === 'Identifier')
    return String(node.name)
  if (node.type === 'MemberExpression' && node.computed !== true) {
    const prop = keyName(node.property)
    const obj = exprName(node.object)
    if (obj !== undefined && prop !== undefined)
      return `${obj}.${prop}`
    return prop
  }
  if (node.type === 'ChainExpression')
    return exprName(node.expression)
  return undefined
}

function inferFunctionName(node: AstNode, parent: AstNode | undefined): string {
  const ownId = isAstNode(node.id) ? keyName(node.id) : undefined
  if (ownId !== undefined)
    return ownId
  if (parent === undefined)
    return '<anonymous>'
  if (parent.type === 'ExportDefaultDeclaration')
    return 'default'
  if (parent.type === 'VariableDeclarator' && isAstNode(parent.id) && parent.id.type === 'Identifier')
    return String(parent.id.name)
  if (parent.type === 'PropertyDefinition')
    return keyName(parent.key) ?? '<field>'
  if (parent.type === 'Property') {
    const base = keyName(parent.key) ?? '<prop>'
    return parent.kind === 'get' || parent.kind === 'set' ? `${parent.kind} ${base}` : base
  }
  if (parent.type === 'AssignmentExpression')
    return exprName(parent.left) ?? '<assigned>'
  if (parent.type === 'CallExpression') {
    const callee = exprName(parent.callee)
    return callee !== undefined ? `${callee}()` : '<callback>'
  }
  return '<anonymous>'
}

function computeComplexity(fnNode: AstNode): number {
  let complexity = 1
  const visit = (value: unknown, isRoot: boolean): void => {
    if (value === null || typeof value !== 'object')
      return
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++)
        visit(value[i], false)
      return
    }
    if (!isAstNode(value))
      return
    if (!isRoot && NESTED_BOUNDARY.has(value.type))
      return
    if (BRANCH_NODES.has(value.type)) {
      complexity++
    }
    else if (value.type === 'SwitchCase' && value.test !== null && value.test !== undefined) {
      complexity++
    }
    else if (value.type === 'LogicalExpression' && (value.operator === '&&' || value.operator === '||' || value.operator === '??')) {
      complexity++
    }
    const children = childEntries(value)
    for (let i = 0; i < children.length; i++)
      visit(children[i], false)
  }
  visit(fnNode, true)
  return complexity
}

function scopeLabelForContainer(node: AstNode, parent: AstNode | undefined): string | undefined {
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    const id = isAstNode(node.id) ? keyName(node.id) : undefined
    if (id !== undefined)
      return id
    if (parent?.type === 'VariableDeclarator' && isAstNode(parent.id) && parent.id.type === 'Identifier')
      return String(parent.id.name)
    return '<class>'
  }
  if (node.type === 'ObjectExpression' && parent?.type === 'VariableDeclarator' && isAstNode(parent.id) && parent.id.type === 'Identifier')
    return String(parent.id.name)
  return undefined
}

export function analyzeFile(filename: string, code: string): FileMetrics {
  const lang = /\.[cm]?ts$/i.test(filename) ? 'ts' : 'tsx'
  const parsed = parseSync(filename, code, { lang, sourceType: 'module' })
  if (parsed.errors.length > 0)
    throw new Error(`size-check: failed to parse ${filename}: ${parsed.errors[0]!.message}`)

  const { lineStarts, codePrefix } = buildLineIndex(code, parsed.comments)
  const fileLines = codePrefix[codePrefix.length - 1]!
  const functions: FunctionMetric[] = []
  const seenKeys = new Map<string, number>()

  const uniqueKey = (scope: readonly string[], name: string): string => {
    const base = scope.length > 0 ? `${scope.join('.')}.${name}` : name
    const count = (seenKeys.get(base) ?? 0) + 1
    seenKeys.set(base, count)
    return count === 1 ? base : `${base}#${count}`
  }

  const recordFunction = (spanNode: AstNode, complexityNode: AstNode, name: string, scope: readonly string[]): string => {
    const key = uniqueKey(scope, name)
    const startLine = offsetToLine(lineStarts, spanNode.start)
    const endLine = offsetToLine(lineStarts, Math.max(spanNode.start, spanNode.end - 1))
    const lines = codePrefix[endLine + 1]! - codePrefix[startLine]!
    functions.push({
      key,
      lines,
      complexity: computeComplexity(complexityNode),
      line: startLine + 1,
    })
    return key
  }

  const walk = (value: unknown, parent: AstNode | undefined, scope: readonly string[]): void => {
    if (value === null || typeof value !== 'object')
      return
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++)
        walk(value[i], parent, scope)
      return
    }
    if (!isAstNode(value))
      return

    if (value.type === 'MethodDefinition') {
      const fn = value.value
      if (isAstNode(fn) && fn.body !== null && fn.body !== undefined) {
        const rawName = keyName(value.key) ?? '<method>'
        const label = value.kind === 'get' || value.kind === 'set' ? `${value.kind} ${rawName}` : rawName
        const fullKey = recordFunction(value, fn, label, scope)
        const nextScope = [fullKey]
        for (const child of childEntries(fn))
          walk(child, fn, nextScope)
      }
      return
    }

    if (value.type === 'FunctionDeclaration' || value.type === 'FunctionExpression' || value.type === 'ArrowFunctionExpression') {
      if (value.body === null || value.body === undefined)
        return
      const name = inferFunctionName(value, parent)
      const fullKey = recordFunction(value, value, name, scope)
      const nextScope = [fullKey]
      for (const child of childEntries(value))
        walk(child, value, nextScope)
      return
    }

    const container = scopeLabelForContainer(value, parent)
    const nextScope = container !== undefined ? [...scope, container] : scope
    const nextParent = TRANSPARENT_PARENTS.has(value.type) ? parent : value
    for (const child of childEntries(value))
      walk(child, nextParent, nextScope)
  }

  walk(parsed.program, undefined, [])
  return { file: filename, lines: fileLines, functions }
}

export async function scanProject(root: string): Promise<FileMetrics[]> {
  const files: string[] = []
  for await (const rel of new Glob('packages/*/src/**/*.{ts,tsx}').scan(root))
    files.push(rel.replaceAll('\\', '/'))
  files.sort()

  const results: FileMetrics[] = []
  for (const rel of files) {
    const code = await Bun.file(join(root, rel)).text()
    results.push(analyzeFile(rel, code))
  }
  return results
}

function sortRecord(entries: [string, number][]): Record<string, number> {
  entries.sort((a, b) => a[0].localeCompare(b[0]))
  return Object.fromEntries(entries)
}

export function buildRatchet(metrics: readonly FileMetrics[]): SizeRatchet {
  const files: [string, number][] = []
  const functionLines: [string, number][] = []
  const functionComplexity: [string, number][] = []

  for (const m of metrics) {
    if (m.lines > MAX_FILE_LINES)
      files.push([m.file, m.lines])
    for (const fn of m.functions) {
      const fullKey = `${m.file}::${fn.key}`
      if (fn.lines > MAX_FN_LINES)
        functionLines.push([fullKey, fn.lines])
      if (fn.complexity > MAX_FN_COMPLEXITY)
        functionComplexity.push([fullKey, fn.complexity])
    }
  }

  return {
    files: sortRecord(files),
    functionLines: sortRecord(functionLines),
    functionComplexity: sortRecord(functionComplexity),
  }
}

function checkBucket(
  kind: MetricKind,
  current: ReadonlyMap<string, number>,
  ratchetBucket: Readonly<Record<string, number>>,
  limit: number,
  violations: CheckViolation[],
  shrinks: CheckShrink[],
): void {
  for (const [key, value] of current) {
    const recorded = ratchetBucket[key]
    const cap = recorded ?? limit
    if (value > cap) {
      violations.push({ kind, key, value, cap, limit, ratcheted: recorded !== undefined })
    }
    else if (recorded !== undefined && value < recorded) {
      shrinks.push({ kind, key, was: recorded, now: value })
    }
  }
  for (const [key, was] of Object.entries(ratchetBucket)) {
    if (!current.has(key))
      shrinks.push({ kind, key, was, now: undefined })
  }
}

export function checkMetrics(metrics: readonly FileMetrics[], ratchet: SizeRatchet): CheckReport {
  const fileMap = new Map<string, number>()
  const fnLinesMap = new Map<string, number>()
  const fnComplexityMap = new Map<string, number>()
  let functionCount = 0

  for (const m of metrics) {
    fileMap.set(m.file, m.lines)
    for (const fn of m.functions) {
      functionCount++
      const fullKey = `${m.file}::${fn.key}`
      fnLinesMap.set(fullKey, fn.lines)
      fnComplexityMap.set(fullKey, fn.complexity)
    }
  }

  const violations: CheckViolation[] = []
  const shrinks: CheckShrink[] = []
  checkBucket('file', fileMap, ratchet.files, MAX_FILE_LINES, violations, shrinks)
  checkBucket('functionLines', fnLinesMap, ratchet.functionLines, MAX_FN_LINES, violations, shrinks)
  checkBucket('functionComplexity', fnComplexityMap, ratchet.functionComplexity, MAX_FN_COMPLEXITY, violations, shrinks)

  return { violations, shrinks, fileCount: metrics.length, functionCount }
}

const KIND_UNIT: Record<MetricKind, string> = {
  file: 'code lines',
  functionLines: 'code lines',
  functionComplexity: 'complexity',
}

export function formatViolation(v: CheckViolation): string {
  const unit = KIND_UNIT[v.kind]
  const capText = v.ratcheted ? `ratchet ${v.cap}, limit ${v.limit}` : `limit ${v.limit}`
  const target = v.kind === 'file' ? 'file' : 'function'
  return `${v.key}: ${v.value} ${unit} (${capText}) — split the ${target}`
}

function formatShrink(s: CheckShrink): string {
  const unit = KIND_UNIT[s.kind]
  if (s.now === undefined)
    return `${s.key}: removed (was ${s.was} ${unit})`
  return `${s.key}: ${s.was} -> ${s.now} ${unit}`
}

async function readRatchet(path: string): Promise<SizeRatchet> {
  if (!existsSync(path))
    return { files: {}, functionLines: {}, functionComplexity: {} }
  const data = (await Bun.file(path).json()) as Partial<SizeRatchet>
  return {
    files: data.files ?? {},
    functionLines: data.functionLines ?? {},
    functionComplexity: data.functionComplexity ?? {},
  }
}

const USAGE = 'bun run check:size [options]: enforces the 600-line file, 150-line function, and 40-complexity caps on packages/*/src/**/*.{ts,tsx} against scripts/size-ratchet.json'

if (import.meta.main) {
  process.exitCode = await runMain({
    name: 'size-check',
    usage: false,
    run: async (args) => {
      const { values } = parse(args, USAGE, {
        update: { type: 'boolean', description: 'recompute scripts/size-ratchet.json from the current tree (lowers or removes shrunk entries)' },
        root: { type: 'string', description: 'project root to scan (defaults to the repository root)' },
        ratchet: { type: 'string', description: 'path to the ratchet JSON file (defaults to scripts/size-ratchet.json)' },
      }, { exits: [[0, 'all files and functions are within their caps'], [1, 'one or more files or functions exceeded a cap'], [2, 'a usage error']] })

      const root = values.root !== undefined ? resolve(values.root) : ROOT
      const ratchetPath = values.ratchet !== undefined ? resolve(values.ratchet) : (values.root !== undefined ? join(root, 'scripts/size-ratchet.json') : DEFAULT_RATCHET)
      const metrics = await scanProject(root)

      if (values.update === true) {
        const next = buildRatchet(metrics)
        await Bun.write(ratchetPath, `${JSON.stringify(next, null, 2)}\n`)
        const rel = ratchetPath.startsWith(`${root}/`) ? ratchetPath.slice(root.length + 1) : ratchetPath
        console.log(`wrote ${rel} (${Object.keys(next.files).length} files, ${Object.keys(next.functionLines).length} long fns, ${Object.keys(next.functionComplexity).length} complex fns)`)
        return 0
      }

      const ratchet = await readRatchet(ratchetPath)
      const report = checkMetrics(metrics, ratchet)

      if (report.shrinks.length > 0) {
        console.log(`ratchet can be lowered for ${report.shrinks.length} entr${report.shrinks.length === 1 ? 'y' : 'ies'} (run \`bun run check:size --update\`):`)
        for (const s of report.shrinks)
          console.log(`  - ${formatShrink(s)}`)
      }

      if (report.violations.length > 0) {
        for (const v of report.violations)
          console.error(`  ✗ ${formatViolation(v)}`)
        return fail(
          `${report.violations.length} size/complexity cap violation${report.violations.length === 1 ? '' : 's'}`,
          1,
          'split the offending file or function; if an existing entry shrank after a split, run `bun run check:size --update`',
        )
      }

      console.log(`✓ size caps ok (${report.fileCount} files, ${report.functionCount} functions)`)
      return 0
    },
  })
}
