import { elementsIn } from '../compiler/ast'
import { parseKay } from '../compiler/parser'
import { analyzeScript } from '../compiler/script'

export interface ComponentInterface {
  props: { name: string, optional: boolean }[]
  // The blocks the component renders where it writes `slot name`, which a caller fills with `@name`.
  blocks: string[]
}

const COMMENT = /\/\/.*$/gm
const MEMBER = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:/
const IDENTIFIER = /^[A-Z_$][\w$]*$/i

// What a caller of a component can pass it: the keys of its `props<T>()` type, a type written in place or named in its script, and the names it destructures.
export function componentInterface(source: string): ComponentInterface {
  const file = parseKay(source)
  const analysis = analyzeScript(source, file.script)
  const props = new Map<string, boolean>()

  if (analysis.props) {
    const type = analysis.props.type && source.slice(analysis.props.type.start, analysis.props.type.end).trim()
    const body = type === undefined ? undefined : literalOf(type, source.slice(file.script?.start ?? 0, file.script?.end ?? 0))

    for (const [name, optional] of body === undefined ? [] : memberKeys(body))
      props.set(name, optional)

    for (const binding of analysis.props.bindings)
      props.set(binding.key, props.get(binding.key) ?? binding.fallback !== undefined)
  }

  const blocks = [...elementsIn(file.template)].flatMap(element => element.outlet ? [source.slice(element.outlet.name.start, element.outlet.name.end)] : [])

  return { props: [...props].map(([name, optional]) => ({ name, optional })), blocks: [...new Set(blocks)] }
}

// The type literal a props type is written as: in place, or declared by name in the script.
function literalOf(type: string, script: string): string | undefined {
  if (type.startsWith('{'))
    return type

  return IDENTIFIER.test(type) ? declaredBody(script, type) : undefined
}

// The `{ ... }` of `interface Name` or `type Name =` in a script.
function declaredBody(script: string, name: string): string | undefined {
  const head = new RegExp(`(?:interface\\s+${name}\\b[^{=]*|type\\s+${name}\\b[^=]*=\\s*)\\{`).exec(script)

  if (!head)
    return undefined

  const start = head.index + head[0].length - 1
  let depth = 0

  for (let index = start; index < script.length; index++) {
    if (script[index] === '{')
      depth++
    else if (script[index] === '}' && --depth === 0)
      return script.slice(start, index + 1)
  }

  return undefined
}

// The names a type literal declares, with whether each is optional; members nested deeper are not its own.
function memberKeys(literal: string): [string, boolean][] {
  const text = literal.replace(COMMENT, '').slice(1, -1)
  const members: string[] = []
  let depth = 0
  let from = 0
  let quote = ''

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!

    if (quote !== '') {
      if (char === '\\')
        index++
      else if (char === quote)
        quote = ''
    }
    else if (char === '"' || char === '\'' || char === '`') {
      quote = char
    }
    else if ('([{<'.includes(char)) {
      depth++
    }
    else if (')]}'.includes(char) || (char === '>' && text[index - 1] !== '=')) {
      depth--
    }
    else if (depth === 0 && (char === ';' || char === ',' || char === '\n')) {
      members.push(text.slice(from, index))
      from = index + 1
    }
  }

  members.push(text.slice(from))

  return members.flatMap((member) => {
    const found = MEMBER.exec(member.trim())

    return found ? [[found[1]!, found[2] === '?'] as [string, boolean]] : []
  })
}
