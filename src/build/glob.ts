import type * as t from '@babel/types'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parse } from '@babel/parser'
import { KayError } from '../compiler/errors'
import { loadTraverse } from '../compiler/rewrite'
import { GLOBBED } from './globbed'
import { ICON_IMPORT, iconNames, installedIconSets } from './icons'

interface GlobCall {
  start: number
  end: number
  patterns: string[]
  eager: boolean
  import?: string | undefined
}

export const GLOB_CALL = 'import.meta.glob'
const GLOB_MAGIC = /[*?[\]{}()!]/
const RELATIVE = /^\.\.?\//
const NEGATED = /^!/
const IDENTIFIER = /^[A-Z_$][\w$]*$/i
const ICONS = '~icons/'
const ALTERNATIVES = /\{([^{}]*)\}/

const OPTIONS = new Set(['eager', 'import'])
const ICON_USAGE = 'import.meta.glob(\'~icons/tabler/{home,mail}\', { eager: true, import: \'default\' })'
const USAGE = 'import.meta.glob(\'./demos/*.kay\', { eager: true, import: \'default\' })'

// Every file a call's patterns match, by the key it gets: as written from the importer, `./demos/a.kay`, or from the project's root for a pattern starting at it, `/src/demos/a.kay`; an icon pattern, `~icons/tabler/{home,mail}`, gives the icon's own import specifier as both.
// Negated patterns, `!./demos/draft.kay`, leave files out; `node_modules` is only searched by a pattern naming it, and the importer never matches itself.
export function globFiles(patterns: string[], importer: string, root: string): Map<string, string> {
  const from = dirname(importer)
  const icons = iconMatches(patterns, root)
  const absolute = (pattern: string) => RELATIVE.test(pattern) ? resolve(from, pattern) : join(root, pattern)
  const excluded = patterns.filter(pattern => pattern.startsWith('!') && !pattern.startsWith(`!${ICONS}`)).map(pattern => new Bun.Glob(absolute(pattern.slice(1))))
  const files = new Map<string, string>()

  for (const pattern of patterns.filter(pattern => !pattern.startsWith('!') && !pattern.startsWith(ICONS))) {
    const full = absolute(pattern)
    const segments = full.split(sep)
    const magic = segments.findIndex(segment => GLOB_MAGIC.test(segment))
    const base = magic === -1 ? dirname(full) : segments.slice(0, magic).join(sep) || sep

    GLOBBED.add(base)

    // A folder not made yet holds no file; `kay dev` still sees it appear through `GLOBBED`.
    if (!existsSync(base))
      continue

    const searchesModules = pattern.includes('node_modules')

    for (const found of new Bun.Glob(relative(base, full)).scanSync({ cwd: base, absolute: true, onlyFiles: true })) {
      if (found === importer || (!searchesModules && relative(base, found).split(sep).includes('node_modules')) || excluded.some(glob => glob.match(found)))
        continue

      const path = relative(RELATIVE.test(pattern) ? from : root, found).split(sep).join('/')

      const relativeKey = path.startsWith('../') ? path : `./${path}`

      files.set(RELATIVE.test(pattern) ? relativeKey : `/${path}`, found)
    }
  }

  return new Map([...files, ...icons].sort(([a], [b]) => a < b ? -1 : 1))
}

// The icons of the installed sets an icon pattern names, `~icons/<set>/<name>` with the wildcards and braces of a glob, each as its import specifier; a negated one leaves its icons out.
// A name written out, or an alternative of its braces, that no installed set has fails the build, as a misspelt import does; so does a negated pattern with no icon pattern to leave icons out of, and a malformed glob such as `[` matches nothing.
function iconMatches(patterns: string[], root: string): Map<string, string> {
  const wanted = patterns.filter(pattern => pattern.startsWith(ICONS))
  const negated = patterns.filter(pattern => pattern.startsWith(`!${ICONS}`))

  if (wanted.length === 0 && negated.length === 0)
    return new Map()

  if (wanted.length === 0)
    throw new KayError('icon-unresolved', `kay: ${negated[0]} leaves out icons of a pattern that offers none, add the \`~icons/...\` pattern it narrows: ${ICON_USAGE}`)

  const sets = installedIconSets(root)
  const names = new Map<string, string[]>()
  // Only the sets the pattern's first segment names are read, and each once; an icon whose name an import cannot spell is not one a glob offers either.
  const setNames = (prefix: string, file: string) => {
    if (!names.has(prefix))
      names.set(prefix, iconNames(prefix, file).filter(name => ICON_IMPORT.test(`${ICONS}${name}`)))

    return names.get(prefix)!
  }
  const matching = (pattern: string) => {
    const path = pattern.slice(ICONS.length)
    const slash = path.indexOf('/')
    const named = new Bun.Glob(slash === -1 ? path : path.slice(0, slash))
    const matcher = new Bun.Glob(path)

    return [...sets].filter(([prefix]) => named.match(prefix)).flatMap(([prefix, file]) => setNames(prefix, file)).filter(name => matcher.match(name))
  }
  const found = new Map<string, string>()

  for (const pattern of wanted) {
    for (const alternative of expandAlternatives(pattern)) {
      const matches = matching(alternative)

      if (matches.length === 0)
        throw new KayError('icon-unresolved', `kay: ${alternative} matches no icon of the installed sets, \`@iconify-json/<prefix>\` packages the project depends on`)

      for (const name of matches)
        found.set(`${ICONS}${name}`, `${ICONS}${name}`)
    }
  }

  // Braces are expanded first, as a brace can span the slash after the set, `{tabler/home,lucide/mail}`.
  for (const pattern of negated) {
    for (const alternative of expandAlternatives(pattern.slice(1))) {
      for (const name of matching(alternative))
        found.delete(`${ICONS}${name}`)
    }
  }

  return found
}

// `~icons/tabler/{home,mail}` as `~icons/tabler/home` and `~icons/tabler/mail`, each of which must match something.
function expandAlternatives(pattern: string): string[] {
  const group = ALTERNATIVES.exec(pattern)

  if (group === null)
    return [pattern]

  return group[1]!.split(',').flatMap(option => expandAlternatives(pattern.slice(0, group.index) + option + pattern.slice(group.index + group[0].length)))
}

// The files the module's `import.meta.glob` calls match, for a build that follows imports without running the module, such as the stylesheet build.
export function globbedFiles(code: string, importer: string, root: string, loader: Bun.JavaScriptLoader): string[] {
  return code.includes(GLOB_CALL) ? globCalls(code, importer, loader).flatMap(call => [...globFiles(call.patterns.filter(pattern => !pattern.replace(NEGATED, '').startsWith(ICONS)), importer, root).values()]) : []
}

// The module with each `import.meta.glob` call replaced by the record of the files it matches, as Vite does: each module, or with `import` one of its exports, imported up front when `eager`, else behind a function importing it.
// Eager imports go before the module's first line, so its lines keep their numbers.
export function expandGlobs(code: string, importer: string, root: string, loader: Bun.JavaScriptLoader): string {
  if (!code.includes(GLOB_CALL))
    return code

  const calls = globCalls(code, importer, loader)
  const imports: string[] = []
  let expanded = code

  // From the last, so each call's offsets still hold.
  for (let index = calls.length - 1; index >= 0; index--) {
    const call = calls[index]!
    const entries = [...globFiles(call.patterns, importer, root)].map(([key, file], fileIndex) => {
      const specifier = JSON.stringify(file)

      if (!call.eager)
        return `${JSON.stringify(key)}: ${call.import === undefined ? `() => import(${specifier})` : `async () => (await import(${specifier}))[${JSON.stringify(call.import)}]`}`

      const name = `__kayGlob${index}_${fileIndex}`

      imports.push(call.import === undefined ? `import * as ${name} from ${specifier};` : `import { ${IDENTIFIER.test(call.import) ? call.import : JSON.stringify(call.import)} as ${name} } from ${specifier};`)

      return `${JSON.stringify(key)}: ${name}`
    })

    expanded = `${expanded.slice(0, call.start)}({ ${entries.join(', ')} })${expanded.slice(call.end)}`
  }

  return imports.join('') + expanded
}

function globCalls(code: string, importer: string, loader: Bun.JavaScriptLoader): GlobCall[] {
  const calls: GlobCall[] = []
  const ast = parse(code, { sourceType: 'module', attachComment: false, plugins: loader === 'tsx' || loader === 'jsx' ? ['typescript', 'jsx'] : ['typescript'], errorRecovery: true })

  loadTraverse()(ast, {
    noScope: true,
    CallExpression(path) {
      const { callee, arguments: args } = path.node

      if (callee.type !== 'MemberExpression' || callee.object.type !== 'MetaProperty' || callee.object.meta.name !== 'import' || callee.property.type !== 'Identifier' || callee.property.name !== 'glob')
        return

      const refuse = (what: string) => new KayError('glob-import', `kay: import.meta.glob in ${importer} ${what}, as the build reads them before the module runs: ${USAGE}`)
      const [first, second] = args
      const patterns = first?.type === 'ArrayExpression' ? first.elements.map(element => element?.type === 'StringLiteral' ? element.value : undefined) : [first?.type === 'StringLiteral' ? first.value : undefined]

      if (patterns.length === 0 || patterns.includes(undefined))
        throw refuse('takes its patterns as strings written in the call')

      if (patterns.some(pattern => !RELATIVE.test(pattern!.replace(NEGATED, '')) && !pattern!.replace(NEGATED, '').startsWith('/') && !pattern!.replace(NEGATED, '').startsWith(ICONS)))
        throw refuse(`takes patterns starting with ./, ../ or / for the project's root, or ${ICONS} for icons: ${ICON_USAGE}`)

      const options = second === undefined ? [] : objectProperties(second)
      const call: GlobCall = { start: path.node.start!, end: path.node.end!, patterns: patterns as string[], eager: false }

      for (const option of options ?? [undefined]) {
        const key = option?.type === 'ObjectProperty' && !option.computed ? keyName(option.key) : undefined

        if (option?.type !== 'ObjectProperty' || key === undefined || !OPTIONS.has(key))
          throw refuse('takes `eager` and `import` as options written in the call')

        if (key === 'eager' && option.value.type === 'BooleanLiteral')
          call.eager = option.value.value
        else if (key === 'import' && option.value.type === 'StringLiteral')
          call.import = option.value.value
        else
          throw refuse(`takes \`${key}\` as a ${key === 'eager' ? 'boolean' : 'string'} written in the call`)
      }

      calls.push(call)
    },
  })

  return calls
}

function objectProperties(node: t.Node): t.ObjectExpression['properties'] | undefined {
  return node.type === 'ObjectExpression' ? node.properties : undefined
}

function keyName(key: t.ObjectProperty['key']): string | undefined {
  if (key.type === 'Identifier')
    return key.name

  return key.type === 'StringLiteral' ? key.value : undefined
}
