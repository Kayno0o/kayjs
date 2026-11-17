import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, Program } from '../compiler/estree'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseProgram } from '../compiler/estree'
import { apiScope, fromApi, isPlain, keyName } from './api-scope'
import { importedName, importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const KAY = /^kay(?:\/|$)/
const NEEDLE = /\baction\b|\bapi\b/
const VALIBOT = /^valibot(?:\/|$)/
const SOURCE = /\.tsx?$/
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all'])
const ROUTE_SCHEMAS = new Set(['body', 'query', 'params', 'headers', 'cookie'])
const ACTION_SCHEMAS = new Set(['input'])
const RELATIVE = /^\.\.?\//
const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts']
const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'])
const MAX_HOPS = 4

// A module of the project: its program and where it is, so a name it imports from a neighbour is read there.
interface Module {
  ast: Program
  file: string
}

function readModule(from: string, specifier: string): Module | undefined {
  for (const extension of EXTENSIONS) {
    const file = resolve(dirname(from), specifier + extension)

    if (!SOURCE.test(file) || !existsSync(file))
      continue

    try {
      return { ast: parseProgram(readFileSync(file, 'utf8'), { lang: file.endsWith('.tsx') ? 'tsx' : 'ts', recover: true }).program, file }
    }
    catch {
      return undefined
    }
  }

  return undefined
}

// The initializer of the top-level `const name`, exported or not.
function declared(ast: Program, name: string): Node | undefined {
  for (const statement of ast.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

    if (declaration?.type !== 'VariableDeclaration')
      continue

    for (const declarator of declaration.declarations) {
      if (declarator.id.type === 'Identifier' && declarator.id.name === name && declarator.init)
        return declarator.init
    }
  }

  return undefined
}

// The module and the name a relative import binds `local` to; `default` for a default import.
function importedFrom({ ast, file }: Module, local: string): { module: Module, name: string } | undefined {
  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type' || !RELATIVE.test(statement.source.value))
      continue

    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier' || specifier.local.name !== local)
        continue

      const module = readModule(file, statement.source.value)
      const name = specifier.type === 'ImportDefaultSpecifier' ? 'default' : importedName(specifier)

      return module && { module, name }
    }
  }

  return undefined
}

// What a module exports under `name`: a `const`, `export default <expression>`, or one `export { name } from './other'` hop.
function exported(module: Module, name: string, hops = 0): { init: Node, module: Module } | undefined {
  for (const statement of module.ast.body) {
    if (name === 'default' && statement.type === 'ExportDefaultDeclaration' && !statement.declaration.type.endsWith('Declaration'))
      return { init: statement.declaration as unknown as Node, module }

    if (statement.type !== 'ExportNamedDeclaration' || statement.source === null || hops > 0)
      continue

    for (const specifier of statement.specifiers) {
      if ((specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value) !== name)
        continue

      const next = readModule(module.file, statement.source.value)

      return next && exported(next, specifier.local.type === 'Identifier' ? specifier.local.name : specifier.local.value, hops + 1)
    }
  }

  const init = declared(module.ast, name)

  return init && { init, module }
}

function paramName(param: { type: string, left?: unknown, name?: string }): string | undefined {
  if (param.type === 'AssignmentPattern')
    return paramName(param.left as { type: string })

  return param.type === 'Identifier' ? param.name : undefined
}

// Whether the file binds `name` anywhere but its import, as a parameter or a declaration, so a use of it may be that binding.
function rebound(ast: Program, name: string): boolean {
  let found = false

  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === name)
      found = true
    else if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') && node.params.some(param => paramName(param) === name))
      found = true
  })

  return found
}

function fromValibot({ ast }: Module, name: string): boolean {
  return ast.body.some(statement => statement.type === 'ImportDeclaration' && statement.importKind !== 'type' && VALIBOT.test(statement.source.value) && statement.specifiers.some(specifier => specifier.local.name === name)) && !rebound(ast, name)
}

// Whether the expression names `toStandardJsonSchema` anywhere, which gives a valibot schema what it lacks.
function wrapsJsonSchema(node: Node): boolean {
  let found = false

  walk(node, (inner) => {
    if (inner.type === 'Identifier' && inner.name === 'toStandardJsonSchema')
      found = true
  })

  return found
}

// Whether an object literal holds `~standard` with no `jsonSchema` in it; one with a spread, or a `~standard` that is no literal, is taken to have it.
function handWritten(object: Extract<Node, { type: 'ObjectExpression' }>): boolean {
  const standard = object.properties.find(property => isPlain(property) && keyName(property) === '~standard')

  if (standard === undefined || !isPlain(standard) || standard.value.type !== 'ObjectExpression')
    return false

  return standard.value.properties.every(property => isPlain(property) && keyName(property) !== 'jsonSchema')
}

// Whether the expression is a Standard Schema validator known to lack `~standard.jsonSchema`: an object literal written by hand, or what valibot builds, which carries none until `toStandardJsonSchema` wraps it.
// A name is followed to its `const`, here or in a module imported by a relative path; anything else, a call of the app's own or a library other than valibot, is taken to have it.
function lacksJsonSchema(node: Node, module: Module, hops = 0): boolean {
  if (wrapsJsonSchema(node))
    return false

  let current = node

  for (;;) {
    if (WRAPPERS.has(current.type))
      current = (current as unknown as { expression: Node }).expression
    else if (current.type === 'CallExpression')
      current = current.callee
    else if (current.type === 'MemberExpression')
      current = current.object
    else
      break
  }

  if (current.type === 'ObjectExpression')
    return handWritten(current)

  if (current.type !== 'Identifier' || hops > MAX_HOPS)
    return false

  if (fromValibot(module, current.name))
    return true

  const init = declared(module.ast, current.name)

  if (init)
    return lacksJsonSchema(init, module, hops + 1)

  const imported = importedFrom(module, current.name)
  const remote = imported && exported(imported.module, imported.name)

  return remote !== undefined && lacksJsonSchema(remote.init, remote.module, hops + 1)
}

// The values of the options object's members named `names`.
function positions(options: Node | undefined, names: Set<string>): Node[] {
  if (options?.type !== 'ObjectExpression')
    return []

  return options.properties.flatMap(property => isPlain(property) && names.has(keyName(property) ?? '') ? [property.value] : [])
}

// A Standard Schema validator with no `~standard.jsonSchema` where an action's `input` or an API route's `body`, `query`, `params`, `headers` or `cookie` takes a schema: it still validates, but a form shows no constraints, a form or a query is not read as numbers and booleans, and OpenAPI and MCP show an open schema.
// Read in the TypeScript files and the fences of `.kay` files alike, from what the source shows: an object literal with `~standard`, and valibot's builders, followed through a `const` and a relative import.
export async function schemaJson(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return scan(root, options, 'schema-without-json-schema', NEEDLE, ({ file, parsed, report }) => {
    for (const { ast, base } of parsed) {
      const { locals: actions, namespaces } = importsOf(ast, source => KAY.test(source), 'action')
      const scope = apiScope(ast)
      const module: Module = { ast, file }

      walk(ast, (node) => {
        if (node.type !== 'CallExpression')
          return

        let schemas: Node[] = []

        if ((node.callee.type === 'Identifier' && actions.has(node.callee.name)) || (node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.object.type === 'Identifier' && namespaces.has(node.callee.object.name) && node.callee.property.type === 'Identifier' && node.callee.property.name === 'action'))
          schemas = positions(node.arguments[0], ACTION_SCHEMAS)
        else if (node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.type === 'Identifier' && ROUTE_METHODS.has(node.callee.property.name) && fromApi(node.callee.object, scope))
          schemas = positions(node.arguments[2], ROUTE_SCHEMAS)

        for (const schema of schemas.filter(candidate => lacksJsonSchema(candidate, module)))
          report(base + schema.start, base + schema.end, 'this Standard Schema validator has no `~standard.jsonSchema`: it still validates, but a form shows no constraints, a form or a query is not read as numbers and booleans, and OpenAPI and MCP show an open schema', 'give it `~standard.jsonSchema` (Zod 4.2+ and ArkType 2.1.28+ carry it, valibot through `toStandardJsonSchema` from `@valibot/to-json-schema`) or build the schema with `s`', null)
      })
    }
  })
}
