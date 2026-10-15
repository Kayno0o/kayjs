import type { CheckDiagnostic } from '.'
import type { Route } from '../server/routes'
import { parseExpression } from '@babel/parser'
import { serverFacts } from './layout-facts'

interface Field {
  file: string
  source: string
  // Where the name is written, in the file's source.
  at: number
  length: number
  // The field's schema as written, as its syntax tree without positions, so quotes and whitespace do not tell two apart.
  text: string
}

// The keys of a syntax tree node that say where it is written rather than what.
const POSITIONS = new Set(['start', 'end', 'loc', 'extra', 'leadingComments', 'trailingComments', 'innerComments'])

function withoutPositions(key: string, value: unknown): unknown {
  return POSITIONS.has(key) ? undefined : value
}

// A name two files of one route's chain declare in their `query` with schemas written differently, which the server refuses to merge; only schemas written inline as `s.Object({ ... })` are compared, the server checking the others when it renders.
export async function queryClashes(routes: Route[]): Promise<CheckDiagnostic[]> {
  const diagnostics: CheckDiagnostic[] = []
  const fields = new Map<string, Map<string, Field> | undefined>()
  const reported = new Set<string>()

  const read = async (file: string) => {
    if (!fields.has(file))
      fields.set(file, await fieldsOf(file))

    return fields.get(file)
  }

  for (const route of routes) {
    const declared = new Map<string, Field>()

    for (const file of [...route.layouts, route.file]) {
      for (const [name, field] of await read(file) ?? []) {
        const first = declared.get(name)

        if (first && first.text !== field.text && !reported.has(`${field.file}\0${name}`)) {
          const before = field.source.slice(0, field.at).split('\n')

          reported.add(`${field.file}\0${name}`)
          diagnostics.push({ file: field.file, line: before.length, column: before.at(-1)!.length + 1, end: field.at + field.length, message: `\`${name}\` is declared by the \`query\` of ${first.file} with another schema`, help: 'declare it once, in the outermost file that needs it, or write the same schema' })
        }

        if (!first)
          declared.set(name, field)
      }
    }
  }

  return diagnostics
}

async function fieldsOf(file: string): Promise<Map<string, Field> | undefined> {
  const source = await Bun.file(file).text()
  const query = serverFacts(file, source).server?.page?.settings.get('query')

  if (!query)
    return undefined

  try {
    const call = parseExpression(source.slice(query.value.start, query.value.end), { plugins: ['typescript'] })
    const object = call.type === 'CallExpression' ? call.arguments[0] : undefined

    if (object?.type !== 'ObjectExpression')
      return undefined

    const found = new Map<string, Field>()

    for (const property of object.properties) {
      if (property.type !== 'ObjectProperty' || property.computed)
        continue

      const name = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'StringLiteral' ? property.key.value : undefined

      if (name !== undefined)
        found.set(name, { file, source, at: query.value.start + property.key.start!, length: property.key.end! - property.key.start!, text: JSON.stringify(property.value, withoutPositions) })
    }

    return found
  }
  catch {
    return undefined
  }
}
