// The help `kay check` adds to the type errors an author's first template mistakes raise, which TypeScript words for its own types and reports at the element rather than the attribute.
// Each row recognises one mistake by tsgo's code and message and the source at its place; the next mistake is one more row.
import type { Span } from '../compiler/ast'
import type { TsgoDiagnostic } from './diagnose'

const ASSIGNABILITY = 2322
const MISSING_PROPERTY = 2339
const ARGUMENT = 2345

export interface TemplateHint {
  // Where the mistake is, narrowed to the attribute at fault when the source shows it.
  span: Span
  help: string
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
const UNKNOWN_ATTRIBUTE = /Property '(\w+)' does not exist on type 'HtmlAttributes</
const TAG_NAME = /^[\w$.:-]+$/
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

// `elif a`, an element to TypeScript, reported at its opening tag, which the source maps loosely, and again at its closing tag.
const elseIf: Row = (diagnostic, source, _span, tsx) => {
  const name = diagnostic.code === MISSING_PROPERTY ? UNKNOWN_ELEMENT.exec(diagnostic.message)?.[1] : undefined

  if (name === undefined || !ELSE_IF_SPELLINGS.has(name))
    return undefined

  if (tsx.startsWith('</', diagnostic.start))
    return 'duplicate'

  // The source maps the tag loosely, so it is the nth line opening on the name that stands for the nth such tag of the generated code.
  const ordinal = [...tsx.slice(0, diagnostic.start).matchAll(new RegExp(`<${name}(?![\\w$-])`, 'g'))].length
  const token = [...source.matchAll(new RegExp(`^[ \\t]*${name}(?![\\w$-])`, 'gm'))][ordinal]

  if (!token)
    return undefined

  const start = token.index + token[0].length - name.length

  return { span: { start, end: start + name.length }, help: 'kay writes it as two words, `else if condition`' }
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

const ROWS: Row[] = [calledHandler, mistypedBind, elseIf, reactNames, tooltipName]

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
