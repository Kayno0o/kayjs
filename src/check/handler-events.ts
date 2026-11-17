import type { Fix, Span } from '../compiler/ast'
import { attributeNamed } from './template-hints'

// `Type '(next: boolean) => void' is not assignable to type '(event: { checked: boolean; }) => unknown'.` and the incompatible parameter that follows.
const EVENT_CALLBACK = /^Type '([\s\S]+?)' is not assignable to type '\(event: \{ ([\s\S]*?) \}\) => unknown'\.\n\s+Types of parameters '[^']*' and 'event' are incompatible\.\n([\s\S]*)$/
const PARAMETER_TYPE = /(?:to type|from type) '([\s\S]*?)'(?:\.|:)/
const FIELD = /^(\w+)\??:/
const CALLBACK_NAME = /^on[A-Z]\w*$/
const HANDLER_NAME = /^[A-Z_$][\w$]*(?:\??\.[A-Z_$][\w$]*)*$/i
// An object literal type or a named type, which no old argument was apart from a `File`: the handler may be written for the event already.
const OBJECT_TYPE = /^(?:\{|object\b|(?!File\b)[A-Z])/
const COMPONENT = /^([A-Z][\w$]*)(?:[.#][^\s(]*)?\(/
const NAME_AT = /^[\w$]+/
const EVENT_WORD = /\bevent\b/
const ELEMENT = /^[a-z.#][^\s(]*\(/

// What an old-form lint of the type check reports.
export interface OldFormLint {
  message: string
  help: string
  span: Span
  fixes?: Fix[]
}

// The segments of a type's text between its top-level `separator`s.
function splitTop(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let from = 0

  for (const [index, char] of [...text].entries()) {
    if ('{([<'.includes(char)) {
      depth++
    }
    else if ('})]'.includes(char) || (char === '>' && text[index - 1] !== '=')) {
      depth--
    }
    else if (char === separator && depth === 0) {
      parts.push(text.slice(from, index))
      from = index + 1
    }
  }

  parts.push(text.slice(from))

  return parts.map(part => part.trim()).filter(part => part !== '')
}

// How many parameters a function type written as `(a: A, b: B) => R` takes, 1 for any other type, as a signal's `Setter<T>` takes one.
function parameterCount(type: string): number {
  if (!type.startsWith('('))
    return 1

  let depth = 0

  for (const [index, char] of [...type].entries()) {
    if (char === '(')
      depth++
    else if (char === ')' && --depth === 0)
      return splitTop(type.slice(1, index), ',').length
  }

  return 1
}

// Whether the first parameter of a function type written as `(a: A, b: B) => R` is typed as an object, a literal or a named type.
function takesObject(type: string): boolean {
  if (!type.startsWith('('))
    return false

  const first = splitTop(type.slice(1), ',')[0] ?? ''

  // A destructured parameter takes an object whatever its type is called.
  if (first.startsWith('{'))
    return true

  const colon = first.indexOf(':')

  return colon !== -1 && OBJECT_TYPE.test(first.slice(colon + 1).trim())
}

// The component an attribute is written on, read off its line or, for an attribute on a line of its own, the line above it that opens the call.
function componentAt(source: string, at: number): string | undefined {
  const lineEnd = source.indexOf('\n', at)
  const [own, ...above] = source.slice(0, lineEnd === -1 ? source.length : lineEnd).split('\n').toReversed()
  const opened = COMPONENT.exec(own!.trimStart())

  if (opened !== null)
    return opened[1]

  if (ELEMENT.test(own!.trimStart()))
    return undefined

  const indent = own!.length - own!.trimStart().length

  for (const line of above) {
    const trimmed = line.trimStart()

    if (trimmed !== '' && line.length - trimmed.length < indent)
      return COMPONENT.exec(trimmed)?.[1]
  }

  return undefined
}

// A callback a component of a kayjs library takes as one event object since 1.105, given a function written for its positional arguments: the handler of `onValueChange={query.set}`, `onCheckedChange={toggle}` or `onFiles={upload}`.
// The fix wraps a handler written as a name, `event => query.set(event.value)`, passing the fields the handler took, first ones first. It is applied where the handler's parameter is no object, which the old arguments were; a handler taking an object may be written for the event already, so its fix is offered.
export function handlerEventLint(message: string, source: string, span: Span | undefined): OldFormLint | undefined {
  const found = EVENT_CALLBACK.exec(message)

  if (found === null || span === undefined)
    return undefined

  const name = NAME_AT.exec(source.slice(span.start))?.[0]

  if (name === undefined || !CALLBACK_NAME.test(name))
    return undefined

  const component = componentAt(source, span.start)

  if (component === undefined || !new RegExp(`^import\\b[^\\n]*\\b${component}\\b[^\\n]*from\\s+['"]@kayjs/`, 'm').test(source))
    return undefined

  const [, handlerType, eventFields, rest] = found
  const fields = splitTop(eventFields!, ';').flatMap(segment => FIELD.exec(segment)?.[1] ?? [])

  if (fields.length === 0)
    return undefined

  const object = takesObject(handlerType!) || PARAMETER_TYPE.exec(rest!)?.[1]?.startsWith('{') === true
  const taken = fields.slice(0, Math.max(1, Math.min(parameterCount(handlerType!), fields.length)))
  const attribute = attributeNamed(source, { start: span.start, end: source.length }, name)
  const value = attribute === undefined ? undefined : source.slice(attribute.start + name.length + 1, attribute.end)
  const inner = value?.startsWith('{') && value.endsWith('}') ? value.slice(1, -1).trim() : undefined
  const handler = inner !== undefined && HANDLER_NAME.test(inner) && !EVENT_WORD.test(inner) ? inner : undefined
  const written = `event => ${handler}(${taken.map(field => `event.${field}`).join(', ')})`
  const report = {
    message: `\`${name}\` on \`${component}\` takes one event object since 1.105, \`{ ${fields.join(', ')} }\`, where it took ${fields.map(field => `\`${field}\``).join(', ')} as ${fields.length === 1 ? 'its argument' : 'arguments'}`,
    help: handler === undefined ? 'take the event object, `({ value }) => ...`, and read the fields from it' : `write \`${name}={${written}}\``,
    span,
  }

  if (handler === undefined || attribute === undefined)
    return report

  const start = attribute.start + name.length + 1 + value!.indexOf(handler)

  return { ...report, fixes: [{ title: `Write \`${name}={${written}}\``, safe: !object, edits: [{ start, end: start + handler.length, text: written }] }] }
}
