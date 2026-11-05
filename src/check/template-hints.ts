// The help `kay check` adds to the type errors an author's first template mistakes raise, which TypeScript words for its own types and reports at the element rather than the attribute.
// Each row recognises one mistake by tsgo's code and message and the source at its place; the next mistake is one more row.
import type { Span } from '../compiler/ast'
import type { TsgoDiagnostic } from './diagnose'
import { HTML_ELEMENTS } from '../compiler/lints'
import { INPUT_TYPES } from '../input-types'
import { nearest } from '../nearest'
import { SVG_ATTRIBUTE_NAMES } from '../svg-attributes'

const ASSIGNABILITY = 2322
const MISSING_PROPERTY = 2339
const ARGUMENT = 2345
const DID_YOU_MEAN = 2820

export interface TemplateHint {
  // Where the mistake is, narrowed to the attribute at fault when the source shows it.
  span: Span
  help: string
  // Words replacing TypeScript's own, for a report that prints a type kay generated.
  message?: string
}

// A row answers a hint, `'duplicate'` for a report that repeats another's, or undefined when the diagnostic is not its mistake.
// `tsx` is the generated code the diagnostic is an offset into.
type Row = (diagnostic: TsgoDiagnostic, source: string, span: Span, tsx: string) => TemplateHint | 'duplicate' | undefined

// Names a React habit writes where kay writes another.
const REACT_NAMES: Record<string, string> = { className: 'class', htmlFor: 'for' }
const ELSE_IF_SPELLINGS = new Set(['elif', 'elseif', 'elsif'])
const CALLED = /^([\w$.]+)\(([\s\S]*)\)$/
const HANDLER_ATTRIBUTE = /^on[A-Z]\w*=\{/
const VOID_HANDLER = /^Type 'void' is not assignable to type 'EventHandler</
const BIND_ARGUMENT = /^Argument of type '([^']+)' is not assignable to parameter of type '(.+?) \| \(\(current: /
const BIND_ATTRIBUTE = /(?<![\w:$-])bind:value=\{/
const UNKNOWN_ELEMENT = /^Property '([\w$-]+)' does not exist on type 'JSX\.IntrinsicElements'/
const UNKNOWN_ATTRIBUTE = /Property '(\w+)' does not exist on type '(?:Html|Svg)Attributes</
const UNKNOWN_SVG_ATTRIBUTE = /Property '([^']+)' does not exist on type 'SvgAttributes</
const KEYWORD_MISMATCH = /^Type '"([^']*)"' is not assignable to type '(.+?)'\./
const ARIA_STATE = /Types of property ''(aria-[\w-]+)'' are incompatible\.\s+Type '"([^']*)"' is not assignable to type '(.+?)'\.?$/
const KEYWORD_ALIAS = /^\w+<(.*)>$/
const NAME_AT = /^[\w:-]+(?==)/
const TAG_NAME = /^[\w$.:-]+$/
const UNDECLARED_PROP = /^Type '[\s\S]*?' is not assignable to type '([\s\S]*)'\.\n\s*Property '([\w$-]+)' does not exist on type '[\s\S]*'\.?$/
const PROP_MEMBER = /^\s*([\w$]+)\??:([\s\S]*)$/
const COMPONENT_CALL = /^([A-Z][\w$.]*)\(/
const ISLAND_OPTIONS = new Set(['hydrate', 'persist', 'fallback'])
const BLOCK_TYPE = /^(?:\([^)]*\) => )?Element$/
const NAME_ESCAPES = /[$.]/g
const NAME_CHAR = /[\w:$-]/
const CHECKBOX = /\btype\s*=\s*["']checkbox["']/

// What may stand before a `/` that starts a regular expression rather than divides.
const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]$/
const REGEX_KEYWORD = /(?:^|[^\w$])(?:return|typeof|case|of|in|void|delete|throw|yield|await)$/

// The index after the string, template, comment or regular expression starting at `at`, or `at` when none does.
function literalEnd(source: string, at: number): number {
  const char = source[at]

  if (char === '"' || char === '\'') {
    for (let index = at + 1; index < source.length; index++) {
      if (source[index] === '\\')
        index++
      else if (source[index] === char)
        return index + 1
    }

    return source.length
  }

  if (char === '`')
    return templateEnd(source, at)

  if (char !== '/')
    return at

  if (source[at + 1] === '/') {
    const lineEnd = source.indexOf('\n', at)

    return lineEnd === -1 ? source.length : lineEnd
  }

  if (source[at + 1] === '*') {
    const end = source.indexOf('*/', at + 2)

    return end === -1 ? source.length : end + 2
  }

  const before = source.slice(Math.max(0, at - 12), at).trimEnd()

  if (before !== '' && !REGEX_BEFORE.test(before) && !REGEX_KEYWORD.test(before))
    return at

  let inClass = false

  for (let index = at + 1; index < source.length && source[index] !== '\n'; index++) {
    const next = source[index]

    if (next === '\\')
      index++
    else if (next === '[')
      inClass = true
    else if (next === ']')
      inClass = false
    else if (next === '/' && !inClass)
      return index + 1
  }

  return at
}

// The index after the template literal opened at `open`, its `${}` holes read as code.
function templateEnd(source: string, open: number): number {
  for (let index = open + 1; index < source.length; index++) {
    const char = source[index]

    if (char === '\\') {
      index++
    }
    else if (char === '`') {
      return index + 1
    }
    else if (char === '$' && source[index + 1] === '{') {
      index = closing(source, index + 1, '{}') - 1
    }
  }

  return source.length
}

// The end of the group opened at `open`, a bracket of `pair`, past strings, templates, comments, regular expressions and nested brackets.
function closing(source: string, open: number, pair: '()' | '{}'): number {
  let depth = 0

  for (let index = open; index < source.length; index++) {
    const char = source[index]!
    const end = literalEnd(source, index)

    if (end > index) {
      index = end - 1
    }
    else if (char === pair[0]) {
      depth++
    }
    else if (char === pair[1] && --depth === 0) {
      return index + 1
    }
  }

  return source.length
}

// The attributes of the element a diagnostic is reported at, which starts at its tag or inside its list.
function attributeList(source: string, span: Span): Span {
  const lineEnd = source.indexOf('\n', span.start)
  const open = source.indexOf('(', span.start)

  // Reported at an attribute: the list is what follows up to its closing parenthesis.
  if (open === -1 || (lineEnd !== -1 && open > lineEnd))
    return { start: span.start, end: lineEnd === -1 ? source.length : lineEnd }

  const before = source.slice(span.start, open)

  if (TAG_NAME.test(before))
    return { start: open + 1, end: closing(source, open, '()') - 1 }

  return { start: span.start, end: closing(source, span.start - 1, '()') - 1 }
}

// `name={...}` or `name="..."` inside the attributes, as the span of the whole attribute.
function attributeNamed(source: string, list: Span, name: string): Span | undefined {
  let start = source.indexOf(`${name}=`, list.start)

  while (start !== -1 && start < list.end && NAME_CHAR.test(source[start - 1] ?? ' '))
    start = source.indexOf(`${name}=`, start + 1)

  if (start === -1 || start >= list.end)
    return undefined

  const value = start + name.length + 1
  const end = source[value] === '{' ? closing(source, value, '{}') : source.indexOf(source[value]!, value + 1) + 1

  return { start, end: Math.max(end, value) }
}

function escapeName(name: string): string {
  return name.replace(NAME_ESCAPES, '\\$&')
}

// `onClick={bump()}`: the call's result handed where the function goes.
const calledHandler: Row = (diagnostic, source, span) => {
  if (diagnostic.code !== ASSIGNABILITY || !VOID_HANDLER.test(diagnostic.message) || !HANDLER_ATTRIBUTE.test(source.slice(span.start, span.start + 80)))
    return undefined

  const name = source.slice(span.start, source.indexOf('=', span.start))
  const attribute = attributeNamed(source, { start: span.start, end: source.length }, name)

  if (!attribute)
    return undefined

  const value = source.slice(attribute.start + name.length + 2, attribute.end - 1).trim()
  const call = CALLED.exec(value)

  if (!call)
    return undefined

  const [, callee, args] = call
  const wrapped = `\`${name}={() => ${value}}\``

  return { span: attribute, help: args!.trim() === '' && !callee!.includes('.') ? `\`${value}\` runs as the page renders and hands its result over: pass the function, \`${name}={${callee}}\`, or wrap the call, ${wrapped}` : `\`${value}\` runs as the page renders and hands its result over: wrap the call so it runs on the event, ${wrapped}` }
}

// `bind:value` on a signal holding another type than the string an input gives, reported at the tag.
const mistypedBind: Row = (diagnostic, source, span) => {
  const argument = diagnostic.code === ARGUMENT ? BIND_ARGUMENT.exec(diagnostic.message) : null

  if (!argument)
    return undefined

  const list = attributeList(source, span)
  const text = source.slice(list.start, list.end)

  if (!BIND_ATTRIBUTE.test(text))
    return undefined

  const attribute = attributeNamed(source, list, 'bind:value')

  if (!attribute)
    return undefined

  const [, given, held] = argument

  if (CHECKBOX.test(text) && held === 'boolean')
    return { span: attribute, help: 'a checkbox is bound with `bind:checked={...}`, which holds a boolean; `bind:value` holds the checkbox\'s `value` string' }

  if (given === 'string' && held === 'number')
    return { span: attribute, help: '`bind:value` writes a string; for an input give it `type="number"` or `type="range"` for a signal holding a number, or make the signal a string' }

  return { span: attribute, help: `\`bind:value\` writes a ${given} here, and the signal holds ${held}: bind a signal of that type` }
}

// An element name nothing declares, reported at its opening tag, which the source maps loosely, and again at its closing tag.
// `elif` is `else if` written as one word, a snippet is rendered as `{foo()}`, an imported component is capitalised, and a typo is answered with the nearest HTML element.
const unknownElement: Row = (diagnostic, source, _span, tsx) => {
  const name = diagnostic.code === MISSING_PROPERTY ? UNKNOWN_ELEMENT.exec(diagnostic.message)?.[1] : undefined

  if (name === undefined)
    return undefined

  if (tsx.startsWith('</', diagnostic.start))
    return 'duplicate'

  const escaped = escapeName(name)

  // The source maps the tag loosely, so it is the nth line opening on the name that stands for the nth such tag of the generated code.
  const ordinal = [...tsx.slice(0, diagnostic.start).matchAll(new RegExp(`<${escaped}(?![\\w$-])`, 'g'))].length
  const token = [...source.matchAll(new RegExp(`^[ \\t]*${escaped}(?![\\w$-])`, 'gm'))][ordinal]

  if (!token)
    return undefined

  const start = token.index + token[0].length - name.length
  const found = { start, end: start + name.length }

  if (ELSE_IF_SPELLINGS.has(name))
    return { span: found, help: 'kay writes it as two words, `else if condition`' }

  if (new RegExp(`^[ \\t]*snippet\\s+${escaped}(?![\\w$-])`, 'm').test(source))
    return { span: found, help: `\`${name}\` is a snippet, which is rendered in braces: \`{${name}(...)}\`` }

  if (new RegExp(`^[ \\t]*import\\b[^'"\`;]*(?<![\\w$])${escaped}(?![\\w$])[^'"\`;]*['"]`, 'm').test(source)) {
    const component = name[0]!.toUpperCase() + name.slice(1)

    return { span: found, help: `components are capitalised: import it as \`${component}\` and call \`${component}(...)\`` }
  }

  const near = nearest(name, [...HTML_ELEMENTS])

  return { span: found, help: `\`${name}\` is no HTML element, snippet or component in scope${near === undefined ? '' : `: did you mean \`${near}\`?`}` }
}

// `className` and `htmlFor`: kay writes the HTML names.
const reactNames: Row = (diagnostic, source, span) => {
  const name = diagnostic.code === ASSIGNABILITY ? UNKNOWN_ATTRIBUTE.exec(diagnostic.message)?.[1] : undefined
  const html = name === undefined ? undefined : REACT_NAMES[name]

  if (name === undefined || html === undefined)
    return undefined

  const attribute = attributeNamed(source, attributeList(source, span), name)

  return attribute && { span: attribute, help: `kay writes the HTML attribute, \`${html}\`, not \`${name}\`` }
}

// `tooltip` on an element: the tooltip attributes are `data-tooltip` and `data-hint`.
const tooltipName: Row = (diagnostic, source, span) => {
  if (diagnostic.code !== ASSIGNABILITY || UNKNOWN_ATTRIBUTE.exec(diagnostic.message)?.[1] !== 'tooltip')
    return undefined

  const attribute = attributeNamed(source, attributeList(source, span), 'tooltip')

  return attribute && { span: attribute, help: 'a tooltip is `data-tooltip="..."` on an element the keyboard reaches (a `button`, a link, or one with `tabindex="0"`), or `data-hint="..."` for text only the pointer adds' }
}

// An attribute that takes a list of keywords, given another: the keywords it takes, from the type TypeScript names, and the one written.
// Reported at the attribute for an HTML attribute (`loading="soon"`) and at the tag for an ARIA state, which is checked through its own type.
const enumeratedValue: Row = (diagnostic, source, span) => {
  if (diagnostic.code !== ASSIGNABILITY && diagnostic.code !== DID_YOU_MEAN)
    return undefined

  const aria = ARIA_STATE.exec(diagnostic.message)
  const direct = aria === null ? KEYWORD_MISMATCH.exec(diagnostic.message) : null
  const name = aria?.[1] ?? NAME_AT.exec(source.slice(span.start))?.[0]
  const given = aria?.[2] ?? direct?.[1]
  const allowed = aria?.[3] ?? direct?.[2]

  if (name === undefined || given === undefined || allowed === undefined)
    return undefined

  const listed = allowed.replace(KEYWORD_ALIAS, '$1')
  const words = listed.includes('...') ? INPUT_TYPES.map(word => `"${word}"`) : listed.split(' | ').filter(word => word.startsWith('"') && word === word.toLowerCase())

  if (words.length === 0)
    return undefined

  const near = words.length > 6 ? nearest(`"${given}"`, words) : undefined

  const attribute = aria === null ? span : attributeNamed(source, attributeList(source, span), name)
  const list = words.length === 1 ? `\`${words[0]}\`` : `${words.slice(0, -1).map(word => `\`${word}\``).join(', ')} or \`${words.at(-1)}\``

  return attribute && { span: attribute, help: near === undefined ? `\`${name}\` takes ${list}, not \`"${given}"\`` : `\`${name}\` does not take \`"${given}"\`: did you mean \`${near}\`?` }
}

// A name outside the SVG attributes: the nearest one, which also answers the React spelling (`strokeWidth`) and the lowercased one (`viewbox`).
const svgAttributeName: Row = (diagnostic, source, span) => {
  const name = diagnostic.code === ASSIGNABILITY ? UNKNOWN_SVG_ATTRIBUTE.exec(diagnostic.message)?.[1] : undefined

  if (name === undefined || REACT_NAMES[name] !== undefined)
    return undefined

  const attribute = attributeNamed(source, attributeList(source, span), name)
  const near = nearest(name, SVG_ATTRIBUTE_NAMES)

  return attribute && { span: attribute, help: `\`${name}\` is no SVG attribute${near === undefined ? '' : `: did you mean \`${near}\`?`}` }
}

// The first object type of the props a component call is checked against, split at its top-level `;` into `[name, type]` pairs.
function declaredProps(type: string): [string, string][] {
  const props: [string, string][] = []
  let depth = 0
  let from = 1

  for (let index = 0; index < type.length; index++) {
    const char = type[index]!

    if ('{(<['.includes(char))
      depth++
    else if ('})>]'.includes(char) && !(char === '>' && type[index - 1] === '='))
      depth--

    if (depth === 0 || (depth === 1 && char === ';')) {
      const member = PROP_MEMBER.exec(type.slice(from, index))

      if (member)
        props.push([member[1]!, member[2]!.trim()])

      from = index + 1
    }

    if (depth === 0)
      break
  }

  return props
}

// The component a props error is about: the call on its line, or for an `@block` the nearest call above at a lesser indentation.
function calledComponent(source: string, at: number): string | undefined {
  const lineEnd = source.indexOf('\n', at)
  const [own, ...above] = source.slice(0, lineEnd === -1 ? source.length : lineEnd).split('\n').toReversed()
  const ownCall = COMPONENT_CALL.exec(own!.trimStart())

  if (ownCall)
    return ownCall[1]

  const indent = own!.length - own!.trimStart().length

  for (const line of above) {
    const trimmed = line.trimStart()

    if (trimmed !== '' && line.length - trimmed.length < indent)
      return COMPONENT_CALL.exec(trimmed)?.[1]
  }

  return undefined
}

// What a component takes, as the end of a sentence, or nothing when its props type is not printed out.
function listed(names: string[] | undefined, none: string, lead: string, prefix: string): string {
  if (names === undefined)
    return ''

  return names.length === 0 ? none : `${lead} ${names.map(name => `\`${prefix}${name}\``).join(', ')}`
}

// A prop a component call gives and the component does not declare, which TypeScript words with the props type it generated.
const undeclaredProp: Row = (diagnostic, source, span) => {
  const found = diagnostic.code === ASSIGNABILITY ? UNDECLARED_PROP.exec(diagnostic.message) : null

  if (!found)
    return undefined

  const [, type, name] = found
  const lineStart = source.lastIndexOf('\n', span.start - 1) + 1
  const line = source.slice(lineStart, !source.includes('\n', lineStart) ? source.length : source.indexOf('\n', lineStart)).trimStart()
  const isBlock = line.startsWith('@')

  if (!isBlock && !COMPONENT_CALL.test(line))
    return undefined

  const component = calledComponent(source, span.start)
  // A props type the component names, `CardProps`, is not printed out, so what it takes is left unsaid.
  const props = type!.startsWith('{') ? declaredProps(type!) : undefined
  const named = component === undefined ? 'the component' : `\`${component}\``
  const attribute = isBlock || name === 'children' ? undefined : attributeNamed(source, attributeList(source, span), name!)
  const where = attribute ?? span

  const taken = isBlock ? `a \`${name}\` block` : `\`${name}\``
  const message = `${named} does not take ${name === 'children' ? 'children' : taken}`

  if (name === 'children')
    return { message, span: where, help: `${named} has no \`slot\`, so it takes no children: add a \`slot\` line where they go, or leave them out` }

  if (isBlock) {
    const blocks = props?.filter(([, kind]) => BLOCK_TYPE.test(kind)).map(([prop]) => prop)

    return { message, span: where, help: `${named} has no \`${name}\` block${listed(blocks, ' and takes no blocks', ', its blocks are', '@')}: a block is a prop typed \`Snippet\`, read with \`slot ${name}\`` }
  }

  if (ISLAND_OPTIONS.has(name!))
    return { message, span: where, help: `\`${name}\` is an option of an island, and ${named} renders on the server alone: it becomes an island once it keeps state or handles an event in the browser` }

  if (name === 'class')
    return { message, span: where, help: `${named} takes no \`class\`: put \`part="root"\` on the element it should reach (or \`part="name"\` for an inner one), or declare \`class?: string\` in its props` }

  const takes = props?.map(([prop]) => prop)

  return { message, span: where, help: `${named} has no \`${name}\` prop${listed(takes, ' and takes no props', ', it takes', '')}: declare it in its \`props<{ ... }>()\`` }
}

const ROWS: Row[] = [calledHandler, mistypedBind, unknownElement, undeclaredProp, reactNames, tooltipName, svgAttributeName, enumeratedValue]

export function templateHint(diagnostic: TsgoDiagnostic, source: string, span: Span | undefined, tsx: string): TemplateHint | 'duplicate' | undefined {
  if (span === undefined)
    return undefined

  for (const row of ROWS) {
    const hint = row(diagnostic, source, span, tsx)

    if (hint !== undefined)
      return hint
  }

  return undefined
}
