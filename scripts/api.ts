import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { Glob } from 'bun'
import ts from 'typescript'
import { writeShadowTypes } from '../src/check/shadow-types'

// `bun scripts/api.ts [--update [--breaking]]`: the public surface of kay and of each library, every `exports` entry's names and their types, as the text files of `api/`.
// Without a flag it prints the difference from the committed snapshot and exits 1 when there is one. `--update` writes the snapshot, and refuses a removed or changed export unless `--breaking` is given, which records it in `api/breaking.txt` for the release to read.
export const SNAPSHOT_DIR = 'api'
export const BREAKING_FILE = `${SNAPSHOT_DIR}/breaking.txt`

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
// A type longer than this is cut and followed by a hash of the whole, so a change past the cut still shows in the diff.
const LONGEST = 300
const FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope

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
async function snapshotOf(dir: string, root: string): Promise<string> {
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
  const short = (text: string) => text.length <= LONGEST ? text : `${text.slice(0, LONGEST)} ...#${Bun.hash(text).toString(16).slice(0, 8)}`
  const show = (type: ts.Type) => short(checker.typeToString(type, undefined, FLAGS))
  const sign = (signature: ts.Signature) => short(checker.signatureToString(signature, undefined, FLAGS))
  // A symbol key is named after its id in the program, which changes with any edit. Members declared by kay or the platform (the attributes of an element a component spreads) are not the package's own API.
  const own = (symbol: ts.Symbol) => !symbol.name.startsWith('__@') && (symbol.declarations ?? []).some((declaration) => {
    const file = declaration.getSourceFile().fileName

    return file.startsWith(dir) && !file.includes('/node_modules/')
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
        blocks.push(`[${specifier}] ${exported.name}\n${lines.join('\n')}`)
    }
  }

  return `${blocks.join('\n\n').replaceAll(root, '<repo>')}\n`
}

// The snapshot of every public package, by file name.
export async function snapshots(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()

  for (const { name, dir } of await packageRoots(root))
    result.set(`${SNAPSHOT_DIR}/${name}.txt`, await snapshotOf(dir, root))

  return result
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

export function compare(committed: string, current: string): ApiChange {
  const before = blocksOf(committed)
  const after = blocksOf(current)

  return {
    added: [...after.keys()].filter(key => !before.has(key)),
    removed: [...before.keys()].filter(key => !after.has(key)),
    changed: [...after.keys()].filter(key => before.has(key) && before.get(key) !== after.get(key)),
  }
}

if (import.meta.main) {
  const root = process.cwd()
  const current = await snapshots(root)
  const update = process.argv.includes('--update')
  const breaking: string[] = []
  const report: string[] = []

  for (const [path, text] of current) {
    const committed = existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : ''
    const { added, removed, changed } = compare(committed, text)

    breaking.push(...[...removed, ...changed].map(key => `${path.slice(SNAPSHOT_DIR.length + 1, -'.txt'.length)} ${key}`))

    for (const [label, keys] of [['added', added], ['removed', removed], ['changed', changed]] as const)
      report.push(...keys.map(key => `${label} ${path} ${key}`))
  }

  if (report.length === 0) {
    console.log('api: unchanged')
  }
  else if (!update) {
    console.log(report.join('\n'))
    process.exit(1)
  }
  else if (breaking.length > 0 && !process.argv.includes('--breaking')) {
    console.log(`${report.join('\n')}\n\nThese remove or change an export a ^ range of an app relies on. Rerun with --breaking if the change means to break it, and add its line to llms/upgrading.md.`)
    process.exit(1)
  }
  else {
    for (const [path, text] of current)
      await Bun.write(join(root, path), text)

    if (breaking.length > 0) {
      const recorded = existsSync(join(root, BREAKING_FILE)) ? readFileSync(join(root, BREAKING_FILE), 'utf8').split('\n').filter(Boolean) : []

      await Bun.write(join(root, BREAKING_FILE), `${[...new Set([...recorded, ...breaking])].sort().join('\n')}\n`)
    }

    console.log(report.join('\n'))
  }
}
