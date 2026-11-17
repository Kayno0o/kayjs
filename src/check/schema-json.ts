import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, Program } from '../compiler/estree'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseProgram } from '../compiler/estree'
import { apiScope, fromApi, isPlain, keyName } from './api-scope'
import { importsOf, walk } from './ast'
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

// The module and the name a relative import binds `local` to.
function importedFrom({ ast, file }: Module, local: string): { module: Module, name: string } | undefined {
  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type' || !RELATIVE.test(statement.source.value))
      continue

    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier' || specifier.local.name !== local)
        continue

      const module = readModule(file, statement.source.value)

      return module && { module, name: specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value }
    }
  }

  return undefined
}

function fromValibot({ ast }: Module, name: string): boolean {
  return ast.body.some(statement => statement.type === 'ImportDeclaration' && statement.importKind !== 'type' && VALIBOT.test(statement.source.value) && statement.specifiers.some(specifier => specifier.local.name === name))
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
  const remote = imported && declared(imported.module.ast, imported.name)

  return imported !== undefined && remote !== undefined && lacksJsonSchema(remote, imported.module, hops + 1)
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
      const actions = importsOf(ast, source => KAY.test(source), 'action').locals
      const scope = apiScope(ast)
      const module: Module = { ast, file }

      walk(ast, (node) => {
        if (node.type !== 'CallExpression')
          return

        let schemas: Node[] = []

        if (node.callee.type === 'Identifier' && actions.has(node.callee.name))
          schemas = positions(node.arguments[0], ACTION_SCHEMAS)
        else if (node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.type === 'Identifier' && ROUTE_METHODS.has(node.callee.property.name) && fromApi(node.callee.object, scope))
          schemas = positions(node.arguments[2], ROUTE_SCHEMAS)

        for (const schema of schemas.filter(candidate => lacksJsonSchema(candidate, module)))
          report(base + schema.start, base + schema.end, 'this Standard Schema validator has no `~standard.jsonSchema`: it still validates, but a form shows no constraints, a form or a query is not read as numbers and booleans, and OpenAPI and MCP show an open schema', 'give it `~standard.jsonSchema` (Zod 4.2+ and ArkType 2.1.28+ carry it, valibot through `toStandardJsonSchema` from `@valibot/to-json-schema`) or build the schema with `s`', null)
      })
    }
  })
}
