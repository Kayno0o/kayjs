import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { Glob } from 'bun'
import ts from 'typescript'
import { writeShadowTypes } from '../src/check/shadow-types'
import { BREAKING_FILE } from './breaking'

// `bun scripts/api.ts [--update [--breaking|--break=<key>...|--compatible]]`: the public surface of kay and of each library, every `exports` entry's names and their types, as the text files of `api/`.
// Without a flag it prints the difference from the committed snapshot and exits 1 when there is one. `--update` writes the snapshot, and refuses a removed or changed export unless `--breaking` is given, which records every such difference in `api/breaking.txt` for the release to read, or `--break=<key>` (the key as the refusal prints it, `<package> [<entry>] <name>`, repeatable), which records that one and still refuses any other. `--compatible` accepts a changed export that stays compatible (an optional member added, a type widened) and records nothing. A removal always needs `--breaking` or its `--break=`.
// What the docs call internal (`INTERNAL`) is written apart, in `api/internal/<package>.txt`, and changes without any flag.
export const SNAPSHOT_DIR = 'api'
export const INTERNAL_DIR = `${SNAPSHOT_DIR}/internal`

interface Manifest {
  name: string
  private?: boolean
  exports?: Record<string, string | Record<string, unknown>>
}

interface Entry {
  specifier: string
  file: string
}

const SOURCE_FILE = /\.(?:ts|tsx|kay)$/
const KAY_FILE = /\.kay$/
const FIRST_LINE = /^.*/
const PAGE = /^\.\/pages\//
const WHITESPACE = /\s+/g
// A type longer than this is written over several lines, one member or union branch a line, so the diff of a change inside it shows the member and not a line of a thousand characters.
const LONGEST = 160
const INDENT = '  '
// Past this many lines a type is summarised, each member of its first level as its start and a hash of the whole member, so an inferred type of hundreds of kilobytes stays a few lines and a change in it still moves one line.
const MOST_LINES = 80
const SUMMARY = 70
const FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope

// What the docs call internal or unstable, per package: whole entries (matched on the `exports` key) and, for an entry that is otherwise API, the names within it. An export classified here is snapshotted apart and changes in any release.
// The rule: an export is API when `llms/`, `llms.txt`, the library's `llms/` and `docs/src/content/docs/` tell an app to import it, and internal when they call it internal, unstable or the compiler's output contract, or never name it and only generated code, a copy of a component or another library of the same release imports it.
export interface InternalRules {
  entries: RegExp[]
  names?: Record<string, string[]>
}

export const INTERNAL: Record<string, InternalRules> = {
  kay: {
    // What compiled `.kay` files and kay's generated entries import (`llms/project.md`), and what kay's libraries share with it, released in lockstep.
    entries: [/^\.\/(?:html|dom|dom-[a-z]+|pending|i18n-links|island|await|client|arrival|jsx-runtime|internal(?:\/.+)?|library(?:\/.+)?)$/],
    // The compile-time machinery behind the generated shadow types, named by no doc.
    names: { '.': ['BindableMark', 'IslandBrand', 'HandedPart', 'HandsPart', 'HandedSignal', 'UnresolvedParameter', 'WidenedProps', 'CheckedHref', 'CheckedHtml', 'BoundProp', 'BoundValue', 'PlainIslandProp', 'FunctionProp', 'Inferred', 'TemplateHelpers', 'TemplateValues', 'TemplateContext', 'Truthy'] },
  },
  // `lib/` and `field-look` are what an ejected copy shares with the library ("for copies and not a stable API", `packages/ui/llms/setup.md`).
  ui: { entries: [/^\.\/lib\//, /^\.\/field-look$/] },
  // The room the entry screen's parts watch through: `entryRoom` and `Member` are documented, the rest only the shipped parts use.
  cms: { entries: [], names: { './room': ['editorsOf', 'hashOf', 'openRoom', 'watchRoom', 'WATCHED_ROWS'] } },
}

export function isInternal(name: string, specifier: string, exported: string): boolean {
  const rules = INTERNAL[name]

  return rules !== undefined && (rules.entries.some(pattern => pattern.test(specifier)) || (rules.names?.[specifier] ?? []).includes(exported))
}

// The packages whose surface is public: kay and every library not marked private.
export async function packageRoots(root: string): Promise<{ name: string, dir: string }[]> {
  const found = [{ name: 'kay', dir: root }]

  for (const path of (await Array.fromAsync(new Glob('packages/*/package.json').scan(root))).sort()) {
    const manifest = JSON.parse(readFileSync(join(root, path), 'utf8')) as Manifest

    if (manifest.private !== true)
      found.push({ name: dirname(path).slice('packages/'.length), dir: join(root, dirname(path)) })
  }

  return found
}

// The source file each `exports` key reaches, a wildcard key expanded over the files its target matches; styles and data files are no API.
function entriesOf(dir: string): Entry[] {
  const { exports = {} } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest
  const entries: Entry[] = []

  for (const [key, value] of Object.entries(exports)) {
    const target = typeof value === 'string' ? value : value.default

    if (typeof target !== 'string' || !SOURCE_FILE.test(target))
      continue

    if (!key.includes('*')) {
      entries.push({ specifier: key, file: resolve(dir, target) })

      continue
    }

    const [before, after] = target.split('*') as [string, string]
    const [keyBefore, keyAfter] = key.split('*') as [string, string]

    for (const path of new Glob(`${before}*${after}`).scanSync({ cwd: dir }))
      entries.push({ specifier: `${keyBefore}${path.slice(before.length, path.length - after.length)}${keyAfter}`, file: resolve(dir, path) })
  }

  return entries.sort((a, b) => a.specifier.localeCompare(b.specifier))
}

// One package's snapshot: a block per exported name, `<entry> <name>` then its type, a component's props listed one a line.
async function snapshotOf(dir: string, root: string, packageName: string): Promise<{ api: string, internal: string }> {
  const entries = entriesOf(dir)
  const types = join(dir, '.kay', 'types')
  const hasKay = entries.some(({ file }) => KAY_FILE.test(file))

  if (hasKay)
    await writeShadowTypes(dir, { typesOnly: true })

  const shadowed = (file: string) => KAY_FILE.test(file) ? join(types, `${relative(dir, file)}.tsx`) : file
  // rootDirs merges the shadow tree with the package at the same relative paths, as `kay check` has it.
  const placed: ts.CompilerOptions = hasKay ? { rootDirs: [dir, types] } : {}
  const configPath = join(dir, 'tsconfig.json')
  const config = ts.getParsedCommandLineOfConfigFile(configPath, { noEmit: true, ...placed }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  } })!
  const ambient = hasKay ? [...new Glob('kay-*.d.ts').scanSync({ cwd: types })].map(name => join(types, name)) : []
  const program = ts.createProgram({ rootNames: [...entries.map(({ file }) => shadowed(file)), ...ambient], options: { ...config.options, ...placed, noEmit: true } })
  const checker = program.getTypeChecker()
  const blocks: string[] = []
  const internalBlocks: string[] = []
  const short = (text: string) => wrap(text)
  const show = (type: ts.Type) => short(checker.typeToString(type, undefined, FLAGS))
  const sign = (signature: ts.Signature) => short(checker.signatureToString(signature, undefined, FLAGS))
  // A symbol key is named after its id in the program, which changes with any edit. Members declared by kay or the platform (the attributes of an element a component spreads) are not the package's own API.
  const own = (symbol: ts.Symbol) => !symbol.name.startsWith('__@') && (symbol.declarations ?? []).some((declaration) => {
    const file = declaration.getSourceFile().fileName

    // kay's own root is the repo's, which also holds the libraries: a type declared under `packages/` is theirs.
    return file.startsWith(dir) && !file.includes('/node_modules/') && !(dir === root && file.startsWith(`${root}/packages/`))
  })
  const members = (type: ts.Type, at: ts.Node): string[] => type.isUnion()
    ? type.types.map(member => `| { ${members(member, at).join('; ')} }`)
    : checker.getPropertiesOfType(type).filter(own).map(property => `${property.name}${property.flags & ts.SymbolFlags.Optional ? '?' : ''}: ${show(checker.getTypeOfSymbolAtLocation(property, at))}`).sort()

  for (const { specifier, file } of entries) {
    const source = program.getSourceFile(shadowed(file))

    if (!source) {
      blocks.push(`${specifier} (unreadable)`)

      continue
    }

    const module = checker.getSymbolAtLocation(source)

    if (!module) {
      blocks.push(`${specifier} (no exports)`)

      continue
    }

    for (const exported of checker.getExportsOfModule(module).sort((a, b) => a.name.localeCompare(b.name))) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
      const lines: string[] = []

      if (symbol.flags & (ts.SymbolFlags.Value)) {
        const type = checker.getTypeOfSymbolAtLocation(symbol, source)
        const signatures = type.getCallSignatures()

        if (symbol.flags & ts.SymbolFlags.Class) {
          const instance = checker.getDeclaredTypeOfSymbol(symbol)

          lines.push(`class ${exported.name}`, ...type.getConstructSignatures().map(signature => `  new ${sign(signature)}`), ...members(instance, source).map(line => `  ${line}`), ...checker.getPropertiesOfType(type).filter(property => own(property) && property.name !== 'prototype').map(property => `  static ${property.name}: ${show(checker.getTypeOfSymbolAtLocation(property, source))}`).sort())
        }
        else if (KAY_FILE.test(file) && exported.name === 'default' && signatures.length > 0) {
          // A page takes the data its server fence gives it, which is no API.
          lines.push(`component ${exported.name}`, ...(PAGE.test(specifier) ? [] : signatures.flatMap(signature => signature.parameters.slice(0, 1).flatMap(parameter => members(checker.getTypeOfSymbolAtLocation(parameter, source), source))).map(line => `  ${line}`)))
        }
        else if (signatures.length > 0) {
          lines.push(...signatures.map(signature => `function ${exported.name}${sign(signature)}`))
        }
        else {
          lines.push(`const ${exported.name}: ${show(type)}`)
        }
      }

      if (symbol.flags & ts.SymbolFlags.Type && !(symbol.flags & ts.SymbolFlags.Class)) {
        const declaration = symbol.declarations?.find(node => ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node))

        if (declaration && ts.isInterfaceDeclaration(declaration)) {
          const parameters = declaration.typeParameters?.map(parameter => parameter.getText()).join(', ')
          const heritage = declaration.heritageClauses?.map(clause => clause.getText()).join(' ')

          lines.push(`interface ${exported.name}${parameters === undefined ? '' : `<${parameters}>`}${heritage === undefined ? '' : ` ${heritage}`}`, ...members(checker.getDeclaredTypeOfSymbol(symbol), source).map(line => `  ${line}`))
        }
        else if (declaration && ts.isTypeAliasDeclaration(declaration)) {
          const parameters = declaration.typeParameters?.map(parameter => parameter.getText()).join(', ')

          lines.push(short(`type ${exported.name}${parameters === undefined ? '' : `<${parameters}>`} = ${declaration.type.getText().replaceAll(WHITESPACE, ' ')}`))
        }
        else {
          lines.push(`type ${exported.name}`)
        }
      }

      if (lines.length > 0)
        (isInternal(packageName, specifier, exported.name) ? internalBlocks : blocks).push(`[${specifier}] ${exported.name}\n${lines.join('\n')}`)
    }
  }

  const text = (list: string[]) => list.length === 0 ? '' : `${list.join('\n\n').replaceAll(root, '<repo>')}\n`

  return { api: text(blocks), internal: text(internalBlocks) }
}

// A type over LONGEST characters, one line per member of an object type, nested ones indented, the members past MOST_LINES lines summarised.
export function wrap(text: string): string {
  if (text.length <= LONGEST)
    return text

  const lines = layout(text).split('\n')

  if (lines.length <= MOST_LINES)
    return lines.join('\n')

  const groups: string[][] = []

  for (const line of lines.slice(MOST_LINES)) {
    if (groups.length === 0 || !(line.startsWith(`${INDENT}${INDENT}`) || line.trimStart().startsWith('}')))
      groups.push([line])
    else
      groups.at(-1)!.push(line)
  }

  return [...lines.slice(0, MOST_LINES), ...groups.map(group => group.length === 1 ? group[0]! : `${group[0]!.slice(0, SUMMARY)} ...#${Bun.hash(group.join('\n')).toString(16).slice(0, 8)} (${group.length} lines)`)].join('\n')
}

function layout(text: string): string {
  let out = ''
  let depth = 0
  let quote = ''

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!

    if (quote !== '') {
      out += char

      if (char === quote && text[index - 1] !== '\\')
        quote = ''

      continue
    }

    if (char === '"' || char === '\'' || char === '`') {
      quote = char
      out += char

      continue
    }

    if (char === '{') {
      if (text[index + 1] === '}') {
        out += '{}'
        index++

        continue
      }

      depth++
      out += `{\n${INDENT.repeat(depth)}`
      index += text[index + 1] === ' ' ? 1 : 0
    }
    else if (char === '}') {
      depth = Math.max(0, depth - 1)
      out = `${out.trimEnd()}\n${INDENT.repeat(depth)}}`
    }
    else if (char === ';' && depth > 0) {
      out += `;\n${INDENT.repeat(depth)}`
      index += text[index + 1] === ' ' ? 1 : 0
    }
    else {
      out += char
    }
  }

  return out
}

// The snapshot of every public package, by file name.
export async function snapshots(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()

  for (const { name, dir } of await packageRoots(root)) {
    const { api, internal } = await snapshotOf(dir, root, name)

    result.set(`${SNAPSHOT_DIR}/${name}.txt`, api)

    if (internal !== '')
      result.set(`${INTERNAL_DIR}/${name}.txt`, internal)
  }

  return result
}

// The snapshot of what the docs call internal, which changes without a flag.
export function isInternalPath(path: string): boolean {
  return path.startsWith(`${INTERNAL_DIR}/`)
}

// The blocks of a snapshot by `[entry] name`.
function blocksOf(text: string): Map<string, string> {
  return new Map(text.split('\n\n').map(block => block.trim()).filter(Boolean).map(block => [FIRST_LINE.exec(block)![0], block]))
}

export interface ApiChange {
  added: string[]
  removed: string[]
  changed: string[]
}

// The `<package> [entry] name` keys a change breaks: a removal always, a changed export unless the author says it stays compatible.
export function breakingKeys(path: string, { removed, changed }: ApiChange, compatible: boolean): string[] {
  if (isInternalPath(path))
    return []

  const name = path.slice(SNAPSHOT_DIR.length + 1, -'.txt'.length)

  return [...removed, ...(compatible ? [] : changed)].map(key => `${name} ${key}`)
}

export function compare(committed: string, current: string): ApiChange {
  const before = blocksOf(committed)
  const after = blocksOf(current)

  return {
    added: [...after.keys()].filter(key => !before.has(key)),
    removed: [...before.keys()].filter(key => !after.has(key)),
    changed: [...after.keys()].filter(key => before.has(key) && before.get(key) !== after.get(key)),
  }
}

export interface PathChange {
  path: string
  change: ApiChange
  before: Map<string, string>
  after: Map<string, string>
}

// The difference of every snapshot file from the committed one. An export that moved between a package's API file and its internal one is neither removed nor added: classifying it is no change of the export.
export function changesOf(root: string, current: Map<string, string>): PathChange[] {
  const read = (path: string) => existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : ''
  const keysOf = (path: string, text: Map<string, string> | string) => new Set(blocksOf(typeof text === 'string' ? text : text.get(path) ?? '').keys())
  const sibling = (path: string) => isInternalPath(path) ? path.replace(`${INTERNAL_DIR}/`, `${SNAPSHOT_DIR}/`) : path.replace(`${SNAPSHOT_DIR}/`, `${INTERNAL_DIR}/`)

  return [...current].map(([path, text]) => {
    const committed = read(path)
    const { added, removed, changed } = compare(committed, text)
    const movedFrom = keysOf(sibling(path), read(sibling(path)))
    const movedTo = keysOf(sibling(path), current.get(sibling(path)) ?? '')

    return { path, change: { added: added.filter(key => !movedFrom.has(key)), removed: removed.filter(key => !movedTo.has(key)), changed }, before: blocksOf(committed), after: blocksOf(text) }
  })
}

// The lines of a changed block that differ, as `- old` and `+ new`, so a change inside a long type shows what moved.
export function lineDiff(before: string, after: string): string[] {
  const old = before.split('\n')
  const next = after.split('\n')

  return [...old.filter(line => !next.includes(line)).map(line => `  - ${line}`), ...next.filter(line => !old.includes(line)).map(line => `  + ${line}`)]
}

// What `--update` does with the breaking keys of a run: `--breaking` records them all, `--break=<key>` only the named, and any left refuses the update.
export function recordBreaking(keys: string[], all: boolean, named: string[]): { record: string[], refused: string[], unknown: string[] } {
  if (all)
    return { record: keys, refused: [], unknown: [] }

  return { record: keys.filter(key => named.includes(key)), refused: keys.filter(key => !named.includes(key)), unknown: named.filter(key => !keys.includes(key)) }
}

if (import.meta.main) {
  const root = process.cwd()
  const current = await snapshots(root)
  const update = process.argv.includes('--update')
  const compatible = process.argv.includes('--compatible')
  const named = process.argv.filter(argument => argument.startsWith('--break=')).map(argument => argument.slice('--break='.length))
  const breaking: string[] = []
  const report: string[] = []
  const stale = [...new Glob(`${INTERNAL_DIR}/*.txt`).scanSync(root)].filter(path => !current.has(path))

  for (const { path, change, before, after } of changesOf(root, current)) {
    const { added, removed, changed } = change

    breaking.push(...breakingKeys(path, change, compatible))

    for (const [label, keys] of [['added', added], ['removed', removed], ['changed', changed]] as const)
      report.push(...keys.map(key => [`${label} ${path} ${key}`, ...(label === 'changed' ? lineDiff(before.get(key)!, after.get(key)!).slice(0, 20) : [])].join('\n')))
  }

  const { record, refused, unknown } = recordBreaking(breaking, process.argv.includes('--breaking'), named)

  if (report.length === 0 && stale.length === 0) {
    console.log('api: unchanged')
  }
  else if (!update) {
    console.log([...report, ...stale.map(path => `stale ${path}`)].join('\n'))
    process.exit(1)
  }
  else if (refused.length > 0 || unknown.length > 0) {
    console.log(`${report.join('\n')}\n\n${refused.length > 0 ? `These remove or change an export a ^ range of an app relies on:\n${refused.map(key => `  ${key}`).join('\n')}\nRerun with --break="<key>" for each one the change means to break (or --breaking for all of them), and add its line to llms/upgrading.md; --compatible accepts changed exports that break nothing (a removal still needs --breaking).\n` : ''}${unknown.length > 0 ? `--break names no breaking difference: ${unknown.join(', ')}\n` : ''}`)
    process.exit(1)
  }
  else {
    for (const [path, text] of current)
      await Bun.write(join(root, path), text)

    for (const path of stale)
      await Bun.file(join(root, path)).delete()

    if (record.length > 0) {
      const recorded = existsSync(join(root, BREAKING_FILE)) ? readFileSync(join(root, BREAKING_FILE), 'utf8').split('\n').filter(Boolean) : []

      await Bun.write(join(root, BREAKING_FILE), `${[...new Set([...recorded, ...record])].sort().join('\n')}\n`)
    }

    console.log(report.join('\n'))
  }
}
