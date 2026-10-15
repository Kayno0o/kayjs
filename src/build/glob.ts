import type * as t from '@babel/types'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parse } from '@babel/parser'
import { KayError } from '../compiler/errors'
import { loadTraverse } from '../compiler/rewrite'
import { GLOBBED } from './globbed'

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

const OPTIONS = new Set(['eager', 'import'])
const USAGE = 'import.meta.glob(\'./demos/*.kay\', { eager: true, import: \'default\' })'

// Every file a call's patterns match, by the key it gets: as written from the importer, `./demos/a.kay`, or from the project's root for a pattern starting at it, `/src/demos/a.kay`.
// Negated patterns, `!./demos/draft.kay`, leave files out; `node_modules` is only searched by a pattern naming it, and the importer never matches itself.
export function globFiles(patterns: string[], importer: string, root: string): Map<string, string> {
  const from = dirname(importer)
  const absolute = (pattern: string) => RELATIVE.test(pattern) ? resolve(from, pattern) : join(root, pattern)
  const excluded = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => new Bun.Glob(absolute(pattern.slice(1))))
  const files = new Map<string, string>()

  for (const pattern of patterns.filter(pattern => !pattern.startsWith('!'))) {
    const full = absolute(pattern)
    const segments = full.split(sep)
    const magic = segments.findIndex(segment => GLOB_MAGIC.test(segment))
    const base = magic === -1 ? dirname(full) : segments.slice(0, magic).join(sep) || sep

    GLOBBED.add(base)

    const searchesModules = pattern.includes('node_modules')

    for (const found of new Bun.Glob(relative(base, full)).scanSync({ cwd: base, absolute: true, onlyFiles: true })) {
      if (found === importer || (!searchesModules && relative(base, found).split(sep).includes('node_modules')) || excluded.some(glob => glob.match(found)))
        continue

      const path = relative(RELATIVE.test(pattern) ? from : root, found).split(sep).join('/')

      const relativeKey = path.startsWith('../') ? path : `./${path}`

      files.set(RELATIVE.test(pattern) ? relativeKey : `/${path}`, found)
    }
  }

  return new Map([...files].sort(([a], [b]) => a < b ? -1 : 1))
}

// The files the module's `import.meta.glob` calls match, for a build that follows imports without running the module, such as the stylesheet build.
export function globbedFiles(code: string, importer: string, root: string, loader: Bun.JavaScriptLoader): string[] {
  return code.includes(GLOB_CALL) ? globCalls(code, importer, loader).flatMap(call => [...globFiles(call.patterns, importer, root).values()]) : []
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
    CallExpression(path) {
      const { callee, arguments: args } = path.node

      if (callee.type !== 'MemberExpression' || callee.object.type !== 'MetaProperty' || callee.object.meta.name !== 'import' || callee.property.type !== 'Identifier' || callee.property.name !== 'glob')
        return

      const refuse = (what: string) => new KayError('glob-import', `kay: import.meta.glob in ${importer} ${what}, as the build reads them before the module runs: ${USAGE}`)
      const [first, second] = args
      const patterns = first?.type === 'ArrayExpression' ? first.elements.map(element => element?.type === 'StringLiteral' ? element.value : undefined) : [first?.type === 'StringLiteral' ? first.value : undefined]

      if (patterns.length === 0 || patterns.includes(undefined))
        throw refuse('takes its patterns as strings written in the call')

      if (patterns.some(pattern => !RELATIVE.test(pattern!.replace(NEGATED, '')) && !pattern!.replace(NEGATED, '').startsWith('/')))
        throw refuse('takes patterns starting with ./, ../ or / for the project\'s root')

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
