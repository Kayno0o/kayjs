import type { Node, Program, Statement } from 'oxc-parser'
import type { Diagnostic, Span } from './ast'
import { isPlainProperty, parseProgram } from './estree'
import { keyName } from './script-shared'

// What a component says of its role with `island({ ... })` at the top of its script: how it renders, when it hydrates, whether it stays across navigations, and which props make a use of it interactive.
export type IslandRender = 'island' | 'client' | 'static'

export interface IslandDeclaration {
  // The whole statement.
  span: Span
  render: IslandRender
  hydrate?: string | undefined
  persist?: boolean | string | undefined
  interactive?: Record<string, boolean> | undefined
  plain?: boolean | undefined
  // What a parent is asked, as the object literal the generated module hands `island()`; none when the call asks nothing.
  asks: string | undefined
}

export const ISLAND_CALL = /\bisland[ \t]*\(/
const RENDERS: ReadonlySet<string> = new Set(['island', 'client', 'static'])
const HYDRATE_TIMINGS = new Set(['load', 'idle', 'visible', 'interaction'])
const KEYS = ['render', 'hydrate', 'persist', 'interactive', 'plain']

// The text of a hydrate the island declaration may ask for.
export function validHydrate(value: string): boolean {
  return HYDRATE_TIMINGS.has(value) || (value.startsWith('media(') && value.endsWith(')') && value.slice(6, -1).trim() !== '')
}

function unwrap(node: Node): Node {
  return node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression' ? unwrap(node.expression) : node
}

export function isIslandCall(statement: Statement): statement is Statement & { type: 'ExpressionStatement' } {
  return statement.type === 'ExpressionStatement' && statement.expression.type === 'CallExpression' && statement.expression.callee.type === 'Identifier' && statement.expression.callee.name === 'island'
}

// The first top-level `island({ ... })` of a script fence, read as written, with what is wrong with it in `problems` and any further one in `repeated`.
export function islandDeclaration(program: Program, shift: (node: Span) => Span, problems: Diagnostic[] = []): IslandDeclaration | undefined {
  const calls = program.body.filter(isIslandCall)
  const first = calls[0]

  if (first === undefined)
    return undefined

  for (const extra of calls.slice(1))
    problems.push({ ...shift(extra), message: 'A component declares `island()` once', help: 'put every setting in the first call' })

  const call = first.expression as Node & { type: 'CallExpression' }
  const span = shift(first)
  const declaration: IslandDeclaration = { span, render: 'island', asks: undefined }
  const report = (at: Node, message: string, help: string) => problems.push({ ...shift(at), message, help })

  if (call.arguments.length > 1)
    report(call, '`island()` takes one object of settings', 'write `island({ hydrate: \'idle\' })`')

  const argument = call.arguments[0]
  const options = argument === undefined || argument.type === 'SpreadElement' ? undefined : unwrap(argument)

  if (argument === undefined)
    return declaration

  if (options?.type !== 'ObjectExpression') {
    report(argument, '`island()` reads an object literal written in place', 'write `island({ hydrate: \'idle\' })`')

    return declaration
  }

  const asked: Record<string, unknown> = {}

  for (const property of options.properties) {
    const name = isPlainProperty(property) && !property.computed ? keyName(property.key) : undefined

    if (!isPlainProperty(property) || name === undefined || !KEYS.includes(name)) {
      report(property, `\`island()\` takes ${KEYS.map(key => `\`${key}\``).join(', ')}`, 'a spread, a computed key, a method or any other name is not read')

      continue
    }

    const value = unwrap(property.value)
    const literal = value.type === 'Literal' ? value.value : undefined

    if (name === 'render') {
      if (typeof literal === 'string' && RENDERS.has(literal))
        declaration.render = literal as IslandRender
      else
        report(property.value, '`render` is `\'island\'`, `\'client\'` or `\'static\'`', '`\'client\'` renders in the browser only, `\'static\'` says nothing in the component needs the browser')
    }
    else if (name === 'hydrate') {
      if (typeof literal === 'string' && validHydrate(literal))
        declaration.hydrate = asked.hydrate = literal
      else if (literal === 'client')
        report(property.value, '`client` is how it renders, not when it hydrates', 'write `render: \'client\'`')
      else
        report(property.value, '`hydrate` is `\'load\'`, `\'idle\'`, `\'visible\'`, `\'interaction\'` or `\'media(<query>)\'` written as a string', 'write `hydrate: \'visible\'`')
    }
    else if (name === 'persist') {
      if (typeof literal === 'boolean' || typeof literal === 'string')
        declaration.persist = asked.persist = literal
      else
        report(property.value, '`persist` is `true` or a key written as a string', 'write `persist: true`')
    }
    else if (name === 'plain') {
      if (typeof literal === 'boolean')
        declaration.plain = asked.plain = literal
      else
        report(property.value, '`plain` is `true` or `false`', 'write `plain: true`')
    }
    else {
      const props = interactiveOf(value)

      if (props === undefined)
        report(property.value, '`interactive` is an object of booleans written in place, each prop with whether it is on when a use leaves it out', 'write `interactive: { sortable: true, selectable: false }`')
      else
        declaration.interactive = asked.interactive = props
    }
  }

  declaration.asks = Object.keys(asked).length === 0 ? undefined : JSON.stringify(asked)

  return declaration
}

function interactiveOf(value: Node): Record<string, boolean> | undefined {
  if (value.type !== 'ObjectExpression')
    return undefined

  const props: Record<string, boolean> = {}

  for (const each of value.properties) {
    const name = isPlainProperty(each) && !each.computed ? keyName(each.key) : undefined

    if (!isPlainProperty(each) || name === undefined || each.value.type !== 'Literal' || typeof each.value.value !== 'boolean')
      return undefined

    props[name] = each.value.value
  }

  return props
}

// The declaration of a script fence, read as the parser needs it: before any analysis, only when the script writes an `island(` at the start of a line.
export function declaredIsland(source: string, script: Span): IslandDeclaration | undefined {
  const text = source.slice(script.start, script.end)

  if (!ISLAND_CALL.test(text))
    return undefined

  try {
    const { program } = parseProgram(text, { recover: true })

    return islandDeclaration(program, node => ({ start: script.start + node.start, end: script.start + node.end }))
  }
  catch {
    return undefined
  }
}

// The role the fence line (`--- client`, `--- island`, `--- static`) or else the `island()` call gives the component, which `client` and `pin` of the parsed file carry whichever wrote it.
export function rolesOf(source: string, script: Span | undefined, fence: Span & { word: string } | undefined): { island: IslandDeclaration | undefined, client: Span | undefined, pin: (Span & { kind: 'island' | 'static' }) | undefined } {
  const island = script === undefined ? undefined : declaredIsland(source, script)

  if (fence?.word === 'client')
    return { island, client: fence, pin: undefined }

  if (fence?.word === 'island' || fence?.word === 'static')
    return { island, client: undefined, pin: { kind: fence.word, start: fence.start, end: fence.end } }

  if (island === undefined)
    return { island, client: undefined, pin: undefined }

  return island.render === 'client' ? { island, client: island.span, pin: undefined } : { island, client: undefined, pin: { kind: island.render, ...island.span } }
}
