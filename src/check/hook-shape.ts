import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { join } from 'node:path'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { CONFIG_FILE } from '../config'
import { walk } from './ast'

const TS_FILE = /\.(?:ts|tsx|mts)$/
const AUTH = /^@kaynooo\/kayjs-auth(?:\/|$)/
const OPEN_PAREN = /\(\s*$/
const QUEUES = /^(?:kay\/server|@kaynooo\/kayjs-mail)(?:\/|$)/

// The `on*` hooks that took positional arguments before 1.70: the name they take now, the event's fields in their old order, and where the call is looked for (the config file, or a file importing a module the pattern accepts).
const HOOKS: Record<string, { now: string, fields: string[], from: RegExp | 'config' }> = {
  onSignUp: { now: 'onSignUp', fields: ['user', 'profile'], from: AUTH },
  onDelete: { now: 'onDelete', fields: ['user'], from: AUTH },
  onExport: { now: 'exportData', fields: ['user'], from: AUTH },
  onProviderProfile: { now: 'profileFields', fields: ['user', 'profile'], from: AUTH },
  onError: { now: 'onError', fields: ['error', 'request'], from: 'config' },
  onFailed: { now: 'onFailed', fields: ['payload', 'error'], from: QUEUES },
}

function keyOf(key: t.Node, computed: boolean): string | undefined {
  if (computed)
    return undefined

  return key.type === 'Identifier' ? key.name : undefined
}

function importsFrom(ast: t.File, matches: RegExp): boolean {
  return ast.program.body.some(statement => statement.type === 'ImportDeclaration' && matches.test(statement.source.value))
}

// The destructuring that replaces the positional parameters, `{ user, profile: p }`, when every parameter is a plain unannotated name within the event's fields.
function destructured(params: t.Node[], fields: string[]): string | undefined {
  if (params.length > fields.length)
    return undefined

  const parts: string[] = []

  for (const [index, param] of params.entries()) {
    if (param.type !== 'Identifier' || param.typeAnnotation || param.optional)
      return undefined

    parts.push(param.name === fields[index] ? param.name : `${fields[index]}: ${param.name}`)
  }

  return `{ ${parts.join(', ')} }`
}

// An `on*` hook (or `onExport` and `onProviderProfile`) still written with positional arguments, which keeps working until 1.73: the hook takes one event object, and a hook returning data is named for what it returns.
export async function hookShapes(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-hook-shape', options.lints)

  if (level === 'allow')
    return []

  const config = join(root, CONFIG_FILE)
  const files = new Set([config, ...await findProjectFiles(root, TS_FILE, { project: true, ownOnly: true })])
  const found: CheckDiagnostic[] = []

  for (const file of files) {
    let source: string
    let ast: t.File

    try {
      source = await Bun.file(file).text()
      ast = parse(source, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
    }
    catch {
      continue
    }

    const wanted = Object.fromEntries(Object.entries(HOOKS).filter(([, hook]) => hook.from === 'config' ? file === config : importsFrom(ast, hook.from)))

    if (Object.keys(wanted).length === 0)
      continue

    walk(ast, (node) => {
      let name: string | undefined
      let fn: t.Node
      let key: t.Node

      if (node.type === 'ObjectProperty') {
        name = keyOf(node.key, node.computed)
        fn = node.value
        key = node.key
      }
      else if (node.type === 'ObjectMethod' && node.kind === 'method') {
        name = keyOf(node.key, node.computed)
        fn = node
        key = node.key
      }
      else {
        return
      }

      const hook = name === undefined ? undefined : wanted[name]

      if (name === undefined || hook === undefined || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression' && fn.type !== 'ObjectMethod'))
        return

      const params = fn.params

      // A hook with no parameter, or one destructuring its event, is the new shape.
      if (params.length === 0 || params[0]!.type === 'ObjectPattern')
        return

      const text = destructured(params, hook.fields)
      const edits: { start: number, end: number, text: string }[] = []

      if (text !== undefined) {
        const first = params[0]!.start!
        const last = params.at(-1)!.end!
        const wrapped = fn.type === 'ArrowFunctionExpression' && !OPEN_PAREN.test(source.slice(0, first))

        edits.push({ start: first, end: last, text: wrapped ? `(${text})` : text })

        if (hook.now !== name)
          edits.push({ start: key.start!, end: key.end!, text: hook.now })
      }

      found.push({
        file,
        ...positionAt(source, key.start!),
        end: key.end!,
        message: hook.now === name ? `\`${name}\` takes one event object now, \`{ ${hook.fields.join(', ')} }\`; positional arguments are read until 1.73` : `\`${name}\` is \`${hook.now}\` now and takes one event object, \`{ ${hook.fields.join(', ')} }\`; the old name is read until 1.73`,
        help: `write \`${hook.now}({ ${hook.fields.join(', ')} })\``,
        code: 'deprecated-hook-shape',
        severity: level === 'warn' ? 'warning' : 'error',
        ...edits.length > 0 && { fixes: [{ title: `Take the event object as \`${hook.now}\``, edits, safe: true }] },
      })
    })
  }

  return found
}
