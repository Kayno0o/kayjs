// `kay upgrade`: moves an app written for the bare `kay` package onto `@kayjs/kay`, its dependency, JSX source and imports.

import type { Program } from 'oxc-parser'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pkg from '../../package.json' with { type: 'json' }
import { relPosix } from '../build/files'
import { resolveKaySpecifier } from '../build/resolve'
import { parseTsx } from '../compiler/analyze'
import { SourceEditor } from '../compiler/patch'

export interface UpgradeResult {
  /** Root-relative files rewritten. */
  changed: string[]
  /** `file:line: what` for each import left for the developer. */
  manual: string[]
}

const BARE_KAY_RE = /^kay(\/[\w-]+)?$/
const BARE_SPECIFIER_RE = /(['"])kay(\/[\w-]+)?\1/g
const DYNAMIC_IMPORT_RE = /\bimport\(\s*(['"])kay(\/[\w-]+)?\1\s*\)/g
const JSX_PRAGMA_RE = /@jsxImportSource\s+kay\b(?!\/)/g
const TSCONFIG_JSX_RE = /("jsxImportSource"\s*:\s*)"kay"/g
const SOURCE_FILE_RE = /\.(?:tsx?|mts)$/
const TSCONFIG_FILE_RE = /^tsconfig(?:\.[\w-]+)?\.json$/
const SKIPPED_DIRS = new Set(['node_modules', 'dist'])
const PUBLIC_ENTRIES = new Set(['', '/server', '/config', '/test', '/build', '/jsx-runtime', '/jsx-dev-runtime'])
// kay v1 served `raw`, `esc` and `escAttr` from `kay/ssr`; v2 exports them from `/server`.
const RENAMED_ENTRIES = new Map([['/ssr', '/server']])
// Names a package moved to another of its entries, so that its root stays importable from an island.
const MOVED_EXPORTS = new Map([['@kayjs/icons', { to: '@kayjs/icons/plugin', names: new Set(['icons', 'IconsPluginOptions']) }]])

/** Rewrites the app at `root` in place; installing the renamed dependency is the caller's job. */
export function upgradeProject(root: string): UpgradeResult {
  const changed: string[] = []
  const manual: string[] = []
  const write = (file: string, before: string, after: string): void => {
    if (after === before)
      return
    writeFileSync(join(root, file), after)
    changed.push(file)
  }
  for (const file of rootFiles(root)) {
    const text = readFileSync(join(root, file), 'utf8')
    if (file === 'package.json')
      write(file, text, upgradePackageJson(text))
    else if (TSCONFIG_FILE_RE.test(file))
      write(file, text, text.replace(TSCONFIG_JSX_RE, '$1"@kayjs/kay"'))
  }
  for (const file of sourceFiles(root)) {
    const text = readFileSync(join(root, file), 'utf8')
    if (text.includes('kay'))
      write(file, text, upgradeSource(file, text, manual))
  }
  return { changed: changed.sort(), manual }
}

function rootFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name).sort()
}

// A folder holding its own package.json is another package, upgraded on its own.
function sourceFiles(root: string, dir = root, out: string[] = []): string[] {
  if (dir !== root && existsSync(join(dir, 'package.json')))
    return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name))
      continue
    const path = join(dir, entry.name)
    if (entry.isDirectory())
      sourceFiles(root, path, out)
    else if (SOURCE_FILE_RE.test(entry.name) && !entry.name.endsWith('.d.ts'))
      out.push(relPosix(root, path))
  }
  return out.sort()
}

// Every `@kayjs/*` package is released at kay's version, so they all move with it.
function upgradePackageJson(text: string): string {
  const json = JSON.parse(text) as Record<string, unknown>
  const range = `^${pkg.version}`
  let touched = false
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = json[field] as Record<string, string> | undefined
    if (deps === undefined || !Object.keys(deps).some(name => name === 'kay' || name.startsWith('@kayjs/')))
      continue
    json[field] = Object.fromEntries(Object.entries(deps).map(([name, version]) => {
      if (name === 'kay' || name.startsWith('@kayjs/')) {
        touched = true
        return [name === 'kay' ? '@kayjs/kay' : name, range]
      }
      return [name, version]
    }))
  }
  if (!touched)
    return text
  const indent = /^\{\n([ \t]+)"/.exec(text)?.[1] ?? '  '
  return `${JSON.stringify(json, null, indent)}\n`
}

const exportCache = new Map<string, Set<string>>()

/** The names an entry of `@kayjs/kay` exports, read from its source. */
function exportsOf(entry: string): Set<string> {
  let names = exportCache.get(entry)
  if (names === undefined) {
    names = new Set()
    const file = resolveKaySpecifier(`@kayjs/kay${entry}`)!
    for (const stmt of parseTsx(file, readFileSync(file, 'utf8')).body) {
      if (stmt.type !== 'ExportNamedDeclaration')
        continue
      for (const spec of stmt.specifiers)
        names.add(spec.exported.type === 'Identifier' ? spec.exported.name : String(spec.exported.value))
      const decl = stmt.declaration
      if (decl === null)
        continue
      if (decl.type === 'VariableDeclaration') {
        for (const d of decl.declarations) {
          if (d.id.type === 'Identifier')
            names.add(d.id.name)
        }
      }
      else if ('id' in decl && decl.id !== null && decl.id.type === 'Identifier') {
        names.add(decl.id.name)
      }
    }
    exportCache.set(entry, names)
  }
  return names
}

function lineOf(code: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset; i++) {
    if (code.charCodeAt(i) === 10)
      line++
  }
  return line
}

type Statement = Program['body'][number]
type ImportStatement = Extract<Statement, { type: 'ImportDeclaration' }>

function upgradeSource(file: string, code: string, manual: string[]): string {
  const editor = new SourceEditor(code)
  const scoped = (quote: string, entry: string): string => `${quote}@kayjs/kay${RENAMED_ENTRIES.get(entry) ?? entry}${quote}`
  for (const stmt of parseTsx(file, code).body) {
    const source = moduleSource(stmt)
    const moves = stmt.type === 'ImportDeclaration' ? MOVED_EXPORTS.get(stmt.source.value) : undefined
    if (moves !== undefined && stmt.type === 'ImportDeclaration') {
      editor.replace(stmt.start, stmt.end, splitImport(code, stmt, code[stmt.source.start]!, moves.to, moves.names))
      continue
    }
    const match = source === undefined ? null : BARE_KAY_RE.exec(source.value)
    if (source === undefined || match === null)
      continue
    const entry = match[1] ?? ''
    const quote = code[source.start]!
    if (!PUBLIC_ENTRIES.has(RENAMED_ENTRIES.get(entry) ?? entry)) {
      manual.push(`${file}:${lineOf(code, stmt.start)}: kay${entry} has no public @kayjs/kay entry: import from @kayjs/kay, /server, /config or /test.`)
      continue
    }
    if (stmt.type === 'ImportDeclaration' && (entry === '/server' || entry === '/ssr'))
      editor.replace(stmt.start, stmt.end, splitServerImport(file, code, stmt, quote, manual))
    else
      editor.replace(source.start, source.end, scoped(quote, entry))
  }
  let out = editor.toString()
  out = out.replace(DYNAMIC_IMPORT_RE, (whole: string, quote: string, entry = '') => whole.replace(BARE_SPECIFIER_RE, scoped(quote, entry)))
  return out.replace(JSX_PRAGMA_RE, '@jsxImportSource @kayjs/kay')
}

function moduleSource(stmt: Statement): { value: string, start: number, end: number } | undefined {
  if (stmt.type === 'ImportDeclaration' || stmt.type === 'ExportAllDeclaration')
    return stmt.source
  if (stmt.type === 'ExportNamedDeclaration')
    return stmt.source ?? undefined
  if (stmt.type === 'TSModuleDeclaration' && stmt.id.type === 'Literal')
    return { value: String(stmt.id.value), start: stmt.id.start, end: stmt.id.end }
  return undefined
}

// `/config` names leave a `kay/server` import for one of their own; a name neither entry exports stays and is reported.
function splitServerImport(file: string, code: string, stmt: ImportStatement, quote: string, manual: string[]): string {
  const specifier = `${quote}@kayjs/kay/server${quote}`
  if (stmt.specifiers.length === 0 || stmt.specifiers.some(s => s.type !== 'ImportSpecifier'))
    return code.slice(stmt.start, stmt.source.start) + specifier + code.slice(stmt.source.end, stmt.end)
  const server = exportsOf('/server')
  const config = exportsOf('/config')
  const keep: string[] = []
  const moved: string[] = []
  for (const spec of stmt.specifiers) {
    if (spec.type !== 'ImportSpecifier')
      continue
    const text = code.slice(spec.start, spec.end)
    const name = spec.imported.type === 'Identifier' ? spec.imported.name : String(spec.imported.value)
    if (!server.has(name) && config.has(name))
      moved.push(text)
    else
      keep.push(text)
    if (!server.has(name) && !config.has(name))
      manual.push(`${file}:${lineOf(code, stmt.start)}: ${name} is not exported by @kayjs/kay/server or @kayjs/kay/config: it is kay's internal API, outside semver.`)
  }
  return importLines(code, stmt, quote, [keep, '@kayjs/kay/server'], [moved, '@kayjs/kay/config'])
}

// The named imports of `stmt` listed in `names` move to the module `to`; the others stay.
function splitImport(code: string, stmt: ImportStatement, quote: string, to: string, names: ReadonlySet<string>): string {
  if (stmt.specifiers.some(s => s.type !== 'ImportSpecifier'))
    return code.slice(stmt.start, stmt.end)
  const keep: string[] = []
  const moved: string[] = []
  for (const spec of stmt.specifiers) {
    const named = spec.type === 'ImportSpecifier' ? (spec.imported.type === 'Identifier' ? spec.imported.name : String(spec.imported.value)) : undefined
    ;(named !== undefined && names.has(named) ? moved : keep).push(code.slice(spec.start, spec.end))
  }
  if (moved.length === 0)
    return code.slice(stmt.start, stmt.end)
  return importLines(code, stmt, quote, [keep, stmt.source.value], [moved, to])
}

// One import statement per non-empty group, each keeping the kind, quote and semicolon of `stmt`.
function importLines(code: string, stmt: ImportStatement, quote: string, ...groups: [string[], string][]): string {
  const head = stmt.importKind === 'type' ? 'import type' : 'import'
  const semi = code[stmt.end - 1] === ';' ? ';' : ''
  return groups.filter(([names]) => names.length > 0).map(([names, from]) => `${head} { ${names.join(', ')} } from ${quote}${from}${quote}${semi}`).join('\n')
}
