// The JSON Schema of what a tool action answers, read from the type tsgo prints for its handler: `WIRE_PRELUDE` turns the return type into the JSON `json()` writes (src/server/mcp.ts), so the declaration emit prints it expanded, and `outputSchemasOf` reads that text.
import type { TSType } from 'oxc-parser'
import { parseSync } from 'oxc-parser'

type Schema = Record<string, unknown>

// What a probe file starts with: `probe(handler)` has the wire form of what the handler answers.
// A Date and a bigint are strings, a Map an object and a Set an array, as `json()` writes them, an object with `toJSON` is what that returns, a function is `undefined` (no property, `null` in an array), and `unknown` stays `unknown`.
// A number that is NaN or Infinity is written as `null` and described as a number: the type cannot tell.
export const WIRE_PRELUDE = `type Wire<T> = unknown extends T ? unknown
  : T extends string | number | boolean | null | undefined ? T
  : T extends bigint | Date ? string
  : T extends (...args: never[]) => unknown ? undefined
  : T extends Map<unknown, infer V> ? { [key: string]: Wire<V> }
  : T extends { toJSON: () => infer R } ? Wire<R>
  : T extends Set<infer V> | readonly (infer V)[] ? Wire<V>[]
  : T extends object ? { [K in keyof T as [T[K]] extends [(...args: never[]) => unknown] ? never : K]: Wire<T[K]> }
  : never
declare function probe<T>(handler: (...args: never[]) => T): Wire<Awaited<T>>`

// Raised for a type no schema describes, which the object around it turns into `{}` and the root into no schema.
const UNTOLD = Symbol('untold')

type Told = Schema | typeof UNTOLD

// The schema of each `export declare const <name>: <type>` of a declaration file: an object schema, or undefined where the answer is not an object or is not told.
export function outputSchemasOf(declarations: string): Map<string, Schema | undefined> {
  const schemas = new Map<string, Schema | undefined>()

  for (const statement of parseSync('probe.d.ts', declarations).program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : undefined

    if (declaration?.type !== 'VariableDeclaration')
      continue

    for (const { id } of declaration.declarations) {
      if (id.type !== 'Identifier' || !id.typeAnnotation)
        continue

      const told = schemaOf(id.typeAnnotation.typeAnnotation)

      schemas.set(id.name, told !== UNTOLD && told.type === 'object' ? told : undefined)
    }
  }

  return schemas
}

const KEYWORDS: Record<string, Schema | undefined> = { TSStringKeyword: { type: 'string' }, TSNumberKeyword: { type: 'number' }, TSBooleanKeyword: { type: 'boolean' }, TSNullKeyword: { type: 'null' } }

// `inArray`: JSON writes `undefined` as `null` in an array, and drops it from an object.
function schemaOf(type: TSType, inArray = false): Told {
  const keyword = KEYWORDS[type.type]

  if (keyword)
    return { ...keyword }

  if (type.type === 'TSLiteralType')
    return literalOf(type.literal)

  if (type.type === 'TSArrayType')
    return { type: 'array', items: valueOf(type.elementType, true) }

  if (type.type === 'TSTypeOperator' && type.operator === 'readonly')
    return schemaOf(type.typeAnnotation)

  if (type.type === 'TSTypeLiteral')
    return objectOf(type.members)

  if (type.type === 'TSUndefinedKeyword' && inArray)
    return { type: 'null' }

  if (type.type === 'TSUnionType')
    return unionOf(type.types, inArray)

  return type.type === 'TSParenthesizedType' ? schemaOf(type.typeAnnotation, inArray) : UNTOLD
}

// Any value where the type is not told.
function valueOf(type: TSType | undefined, inArray = false): Schema {
  const told = type ? schemaOf(type, inArray) : UNTOLD

  return told === UNTOLD ? {} : told
}

function literalOf(literal: Extract<TSType, { type: 'TSLiteralType' }>['literal']): Told {
  if (literal.type === 'Literal' && (typeof literal.value === 'string' || typeof literal.value === 'number' || typeof literal.value === 'boolean'))
    return { const: literal.value }

  if (literal.type === 'UnaryExpression' && literal.operator === '-' && literal.argument.type === 'Literal' && typeof literal.argument.value === 'number')
    return { const: -literal.argument.value }

  return UNTOLD
}

// `name?: T` is not required, and a property of an untold type is any value: the object stays described.
function objectOf(members: Extract<TSType, { type: 'TSTypeLiteral' }>['members']): Told {
  const properties: Record<string, Schema> = {}
  const required: string[] = []
  let additional: Schema | undefined

  for (const member of members) {
    if (member.type === 'TSIndexSignature') {
      additional = valueOf(member.typeAnnotation?.typeAnnotation)

      continue
    }

    if (member.type !== 'TSPropertySignature' || member.computed || (member.key.type !== 'Identifier' && member.key.type !== 'Literal'))
      return UNTOLD

    const name = member.key.type === 'Identifier' ? member.key.name : String(member.key.value)

    const type = member.typeAnnotation?.typeAnnotation
    const told = type ? schemaOf(type) : UNTOLD

    properties[name] = told === UNTOLD ? {} : told

    // JSON drops `undefined`, so a property that may be one, as one of a type not told may be, may be missing.
    if (!member.optional && !mayBeUndefined(type) && told !== UNTOLD)
      required.push(name)
  }

  if (additional && Object.keys(properties).length === 0)
    return { type: 'object', additionalProperties: additional }

  return { type: 'object', properties, ...required.length > 0 && { required }, ...additional && { additionalProperties: additional } }
}

function mayBeUndefined(type: TSType | undefined): boolean {
  return type?.type === 'TSUndefinedKeyword' || (type?.type === 'TSUnionType' && type.types.some(member => member.type === 'TSUndefinedKeyword'))
}

// `undefined` is what JSON drops, so it leaves the union; a union of constants is an enum.
function unionOf(types: TSType[], inArray: boolean): Told {
  const told = types.filter(type => inArray || type.type !== 'TSUndefinedKeyword').map(type => schemaOf(type, inArray))
  const described = told.filter(schema => schema !== UNTOLD)

  if (described.length < told.length || told.length === 0)
    return UNTOLD

  // `undefined` and `null` in an array are one `null`.
  const schemas = described.filter((schema, at) => described.findIndex(other => JSON.stringify(other) === JSON.stringify(schema)) === at)

  if (schemas.length === 1)
    return schemas[0]!

  return schemas.every(schema => 'const' in schema) ? { enum: schemas.map(schema => schema.const) } : { anyOf: schemas }
}
