// The shadow of a plain .ts route file, which a component has by being compiled: an endpoint's `EndpointContext` and an API module's `api()` are typed from the file tree, so the app writes no generic.
import type { Expression, ObjectExpression, PropertyKey } from 'oxc-parser'
import type { Program } from '../compiler/estree'
import type { Mapping } from '../compiler/mapping'
import type { ApiModule } from '../server/api-modules'
import type { Endpoint } from '../server/routes'
import type { ShadowFile } from './shadow'
import { dirname, join, relative, resolve } from 'node:path'
import { SCRIPT_FILE } from '../build/files'
import { SourceMap } from '../compiler'
import { parseProgram } from '../compiler/estree'
import { projectPaths } from '../project'
import { importedName } from './ast'
import { guardAlias, paramsType } from './generated'

// Plain TypeScript, not TSX, as an arrow function written `<T>(x) => x` would be read as JSX there.
const SHADOW_SUFFIX = '.kay.ts'
const CONTEXT_ALIAS = 'KayEndpointContext'
const API_ALIAS = 'kayApi'
const DEFAULT_QUERY = 'Readonly<Record<string, unknown>>'

interface Edit {
  start: number
  end: number
  text: string
}

// What a route file is shadowed for: the guards above it, as the files they are, and what only an endpoint has.
export interface RouteShadowInput {
  guards: string[]
  hasOwnGuards: boolean
  endpoint?: Pick<Endpoint, 'params'>
  api?: Pick<ApiModule, 'file'>
}

export function routeShadowPath(root: string, file: string): string {
  return join(projectPaths(root).types, `${relative(root, file)}${SHADOW_SUFFIX}`)
}

// The source with the edits made and the text `tail` adds, mapped back through the runs the edits leave.
function edited(source: string, edits: Edit[], tail: string): { tsx: string, map: SourceMap } {
  const mappings: Mapping[] = []
  let tsx = ''
  let at = 0

  for (const edit of edits.toSorted((a, b) => a.start - b.start)) {
    mappings.push({ generated: tsx.length, source: at, length: edit.start - at })
    tsx += source.slice(at, edit.start) + edit.text
    at = edit.end
  }

  mappings.push({ generated: tsx.length, source: at, length: source.length - at })
  tsx += `${source.slice(at)}\n${tail}\n`

  return { tsx, map: new SourceMap(mappings.filter(mapping => mapping.length > 0), []) }
}

// The imported name `name` from `module` as an edit giving it the local name `alias`, and the name it had.
function renamedImport(program: ReturnType<typeof parseProgram>['program'], module: string, name: string, alias: string): { edit: Edit, local: string } | undefined {
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== module)
      continue

    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier' || importedName(specifier) !== name)
        continue

      const local = specifier.local.name

      return specifier.local.start === specifier.imported.start
        ? { local, edit: { start: specifier.imported.end, end: specifier.imported.end, text: ` as ${alias}` } }
        : { local, edit: { start: specifier.local.start, end: specifier.local.end, text: alias } }
    }
  }

  return undefined
}

// A `declare global` would be declared twice, by the file and by its shadow.
function declaresGlobal(program: Program): boolean {
  return program.body.some(statement => statement.type === 'TSModuleDeclaration' && (statement.kind === 'global' || (statement as { global?: boolean }).global === true))
}

function leavesProject(program: Program, root: string, file: string): boolean {
  return program.body.some((statement) => {
    const specifier = 'source' in statement && statement.source !== null && statement.source !== undefined ? statement.source.value : undefined

    return typeof specifier === 'string' && specifier.startsWith('.') && relative(root, resolve(dirname(file), specifier)).startsWith('..')
  })
}

// The object literal of `{ ... } as const` or `{ ... } satisfies X`, or of itself.
function pageObject(node: Expression): ObjectExpression | undefined {
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression')
    return pageObject(node.expression)

  return node.type === 'ObjectExpression' ? node : undefined
}

function propertyName(key: PropertyKey): unknown {
  if (key.type === 'Identifier')
    return key.name

  return key.type === 'Literal' ? key.value : undefined
}

// Whether the file declares `export const page = { query: ... }`, whose schema types `ctx.query` as `page.query` does for a page.
function declaresQuery(program: ReturnType<typeof parseProgram>['program']): boolean {
  for (const statement of program.body) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.declaration?.type !== 'VariableDeclaration')
      continue

    for (const declarator of statement.declaration.declarations) {
      if (declarator.id.type === 'Identifier' && declarator.id.name === 'page' && declarator.id.typeAnnotation == null && declarator.init !== null)
        return pageObject(declarator.init)?.properties.some(property => property.type === 'Property' && !property.computed && propertyName(property.key) === 'query') ?? false
    }
  }

  return false
}

// The shadow of an endpoint file or an API module, or undefined when nothing in it is typed from the file tree: no import of `EndpointContext` from `kay` or of `api` from `kay/server`.
export function routeShadow(root: string, file: string, source: string, { guards, hasOwnGuards, endpoint, api }: RouteShadowInput): ShadowFile | undefined {
  if (!source.includes(endpoint ? 'EndpointContext' : 'api'))
    return undefined

  const { program } = parseProgram(source, { lang: 'ts', recover: true })

  // `rootDirs` merges only paths inside the project, so an import leaving it would resolve from the shadow's deeper folder.
  if (leavesProject(program, root, file) || declaresGlobal(program))
    return undefined

  const shadow = routeShadowPath(root, file)
  const specifier = (target: string) => {
    const path = relative(dirname(shadow), target).replace(SCRIPT_FILE, '').split('\\').join('/')

    return JSON.stringify(path.startsWith('.') ? path : `./${path}`)
  }
  const aliases = guards.map(guard => guardAlias(guard))
  const above = `KayGuardValues<[${aliases.map(alias => `typeof ${alias}`).join(', ')}]>`
  const imports = guards.map((guard, index) => `import type ${aliases[index]} from ${specifier(guard)}`)

  if (endpoint) {
    const renamed = renamedImport(program, 'kay', 'EndpointContext', CONTEXT_ALIAS)

    if (!renamed)
      return undefined

    const query = declaresQuery(program) ? 'KayQueryOf<(typeof page)[\'query\']>' : DEFAULT_QUERY
    const tail = [
      'import type { GuardValues as KayGuardValues, QueryOf as KayQueryOf } from \'kay\'',
      ...imports,
      `type ${renamed.local}<Params extends Record<string, unknown> = ${paramsType(endpoint.params)}, Guarded extends object = ${hasOwnGuards ? 'any' : above}, Query = ${query}> = ${CONTEXT_ALIAS}<Params, Guarded, Query>`,
    ].join('\n')

    return { source, file, ...edited(source, [renamed.edit], tail), route: true }
  }

  const renamed = api && renamedImport(program, 'kay/server', 'api', API_ALIAS)

  if (!renamed)
    return undefined

  const options = `Parameters<typeof ${API_ALIAS}>[0]`
  const own = `NonNullable<${options}>['guards']`
  const tail = [
    'import type { GuardValues as KayGuardValues } from \'kay\'',
    ...imports,
    // `Guarded` is what the guards above the module return unless the call names it; `Own` is what its own `guards` return.
    `function ${renamed.local}<Guarded extends object = ${above}, const Own extends ${own} = ${own}>(options: ${options} & { guards?: Own } = {}): ReturnType<typeof ${API_ALIAS}<Guarded, Own>> { return ${API_ALIAS}<Guarded, Own>(options as never) }`,
  ].join('\n')

  return { source, file, ...edited(source, [renamed.edit], tail), route: true }
}
