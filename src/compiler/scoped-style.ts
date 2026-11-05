import { relative, resolve, sep } from 'node:path'
import { hash } from './host'

const LEADING = /^(?:\s|\/\*[\s\S]*?\*\/)*/
const AT_NAME = /^@([\w-]+)/
const GLOBAL = ':global('
const COMBINATORS = ' \t\r\n>+~'
const KEYFRAMES_AT = /^@(?:-[a-z]+-)?keyframes$/i
const GLOBAL_NAME = /^:global\(([^()]+)\)$/
const ANIMATION_DECLARATION = /(^|[;{}\s])((?:-[a-z]+-)?animation(?:-name)?)(\s*:\s*)([^;}]*)/gi
const DATA_PREFIX = /^data-/
const NOT_NEWLINE = /[^\n]/g
const NAME_TOKEN = /-?[_a-z][\w-]*/gi
const LEGACY_PSEUDO_ELEMENT = /^:(?:before|after|first-line|first-letter)\b/
const URL_REFERENCE = /url\(\s*(['"]?)([^)'"\s]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/g
const OUTSIDE_FILE = /^(?:[a-z][\w+.-]*:|\/|#)/i
// At-rules whose body holds style rules of the same page.
const NESTING = new Set(['media', 'supports', 'layer', 'container', 'document', 'scope', 'starting-style'])

// The attribute a component with a `--- style` fence puts on every element its template writes, and its selectors end on.
export function scopeAttribute(moduleId: string): string {
  return `data-k-${scopeHash(moduleId).slice(0, 8)}`
}

export function scopeHash(moduleId: string): string {
  return hash(moduleId)
}

// Where `open` at `from` closes, past strings, comments and nested brackets; the end of `css` when it never does.
function closing(css: string, from: number, open: string, close: string): number {
  let depth = 0

  for (let i = from; i < css.length; i++) {
    const char = css[i]!

    if (char === '\\')
      i++
    else if (char === '"' || char === '\'')
      i = stringEnd(css, i)
    else if (char === '/' && css[i + 1] === '*')
      i = commentEnd(css, i)
    else if (char === open)
      depth++
    else if (char === close && --depth === 0)
      return i
  }

  return css.length
}

function stringEnd(css: string, from: number): number {
  for (let i = from + 1; i < css.length; i++) {
    if (css[i] === '\\')
      i++
    else if (css[i] === css[from])
      return i
  }

  return css.length
}

function commentEnd(css: string, from: number): number {
  const end = css.indexOf('*/', from + 2)

  return end === -1 ? css.length : end + 1
}

// The first `{` or `;` of `css` from `from`, outside strings, comments and brackets.
function preludeEnd(css: string, from: number): number {
  let depth = 0

  for (let i = from; i < css.length; i++) {
    const char = css[i]!

    if (char === '\\')
      i++
    else if (char === '"' || char === '\'')
      i = stringEnd(css, i)
    else if (char === '/' && css[i + 1] === '*')
      i = commentEnd(css, i)
    else if (char === '(' || char === '[')
      depth++
    else if (char === ')' || char === ']')
      depth = Math.max(depth - 1, 0)
    else if (depth === 0 && (char === '{' || char === ';'))
      return i
  }

  return css.length
}

// Splits `text` at each of `separators` outside strings and brackets, keeping them: `a b` is two pieces and a space.
function pieces(text: string, separators: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!

    if (char === '\\') {
      i++
    }
    else if (char === '"' || char === '\'') {
      i = stringEnd(text, i)
    }
    else if (char === '(' || char === '[') {
      depth++
    }
    else if (char === ')' || char === ']') {
      depth = Math.max(depth - 1, 0)
    }
    else if (depth === 0 && separators.includes(char)) {
      if (i > start)
        out.push(text.slice(start, i))

      out.push(char)
      start = i + 1
    }
  }

  if (start < text.length)
    out.push(text.slice(start))

  return out
}

// `compound` with each `:global(...)` unwrapped, what of it is this component's, and whether anything is left: the pseudo-classes and pseudo-elements after a leading `:global(...)` belong to it.
function unwrapped(compound: string): { text: string, ownText: string, own: boolean } {
  let text = ''
  let ownText = ''
  let i = 0

  while (i < compound.length) {
    if (compound.startsWith(GLOBAL, i)) {
      const end = closing(compound, i + GLOBAL.length - 1, '(', ')')

      text += compound.slice(i + GLOBAL.length, end)
      i = end + 1
    }
    else {
      text += compound[i]
      ownText += compound[i]
      i++
    }
  }

  return { text, ownText, own: ownText !== '' && !(compound.startsWith(GLOBAL) && ownText.startsWith(':')) }
}

// Where a pseudo-element starts in `compound`, outside brackets and strings, or its end.
export function pseudoElementAt(compound: string): number {
  let depth = 0

  for (let i = 0; i < compound.length; i++) {
    const char = compound[i]!

    if (char === '\\')
      i++
    else if (char === '"' || char === '\'')
      i = stringEnd(compound, i)
    else if (char === '(' || char === '[')
      depth++
    else if (char === ')' || char === ']')
      depth = Math.max(depth - 1, 0)
    else if (depth === 0 && char === ':' && (compound[i + 1] === ':' || LEGACY_PSEUDO_ELEMENT.test(compound.slice(i))))
      return i
  }

  return compound.length
}

// `css` without its comments, which could split a selector or hide its end.
function withoutComments(css: string): string {
  let out = ''

  for (let i = 0; i < css.length; i++) {
    const char = css[i]!

    if (char === '/' && css[i + 1] === '*') {
      i = commentEnd(css, i)
    }
    else if (char === '"' || char === '\'') {
      const end = stringEnd(css, i)

      out += css.slice(i, end + 1)
      i = end
    }
    else {
      out += char
    }
  }

  return out
}

// A selector cut at its combinators, with the index of the compound the scope attribute ends on: the last one that is this component's, or -1 when the whole selector is global.
export interface SelectorParts {
  parts: { text: string, ownText: string, own: boolean, combinator: boolean, start: number, end: number }[]
  target: number
}

export function selectorParts(selector: string): SelectorParts {
  let offset = 0

  const parts = pieces(selector, COMBINATORS).map((part) => {
    const start = offset

    offset += part.length

    return part.length === 1 && COMBINATORS.includes(part) ? { text: part, ownText: '', own: false, combinator: true, start, end: offset } : { ...unwrapped(part), combinator: false, start, end: offset }
  })

  return { parts, target: parts.findLastIndex(part => !part.combinator && part.own) }
}

function scopeSelector(selector: string, attribute: string): string {
  const { parts, target } = selectorParts(selector)

  return parts.map((part, index) => {
    if (index !== target)
      return part.text

    const pseudo = pseudoElementAt(part.text)

    return `${part.text.slice(0, pseudo)}[${attribute}]${part.text.slice(pseudo)}`
  }).join('')
}

function scopeRule(prelude: string, attribute: string): string {
  const lead = LEADING.exec(prelude)![0]
  const selectors = pieces(withoutComments(prelude.slice(lead.length)), ',')

  return lead + selectors.map(selector => selector === ',' ? selector : scopeSelector(selector, attribute)).join('')
}

// The `@keyframes` names `css` defines, `:global(...)` ones left out, in the rules and the bodies of the at-rules that hold rules.
function keyframeNames(css: string, found = new Set<string>()): Set<string> {
  let i = 0

  while (i < css.length) {
    const stop = preludeEnd(css, i)

    if (css[stop] !== '{') {
      i = stop + 1

      continue
    }

    const end = closing(css, stop, '{', '}')
    const prelude = css.slice(i, stop)
    const head = prelude.slice(LEADING.exec(prelude)![0].length)
    const at = AT_NAME.exec(head)

    if (at !== null && KEYFRAMES_AT.test(`@${at[1]}`)) {
      const name = head.slice(at[0].length).trim()

      if (name !== '' && !GLOBAL_NAME.test(name) && !name.startsWith('"') && !name.startsWith('\''))
        found.add(name)
    }
    else if (at !== null && NESTING.has(at[1]!.toLowerCase())) {
      keyframeNames(css.slice(stop + 1, end), found)
    }

    i = end + 1
  }

  return found
}

// The prelude of a `@keyframes` rule with its name scoped, or unwrapped when it is `:global(...)`.
function keyframesPrelude(prelude: string, renames: ReadonlyMap<string, string>): string {
  const lead = LEADING.exec(prelude)![0].length
  const at = AT_NAME.exec(prelude.slice(lead))![0]
  const rest = prelude.slice(lead + at.length)
  const name = rest.trim()
  const unwrapped = GLOBAL_NAME.exec(name)?.[1]?.trim()

  return `${prelude.slice(0, lead + at.length)}${rest.slice(0, rest.length - rest.trimStart().length)}${unwrapped ?? renames.get(name) ?? name}${rest.slice(rest.trimEnd().length)}`
}

// `declaration` with the scoped keyframe names an `animation` or `animation-name` value holds renamed.
function animationNames(declaration: string, renames: ReadonlyMap<string, string>): string {
  return declaration.replace(ANIMATION_DECLARATION, (_, lead: string, property: string, colon: string, value: string) => `${lead}${property}${colon}${value.replace(NAME_TOKEN, token => renames.get(token) ?? token)}`)
}

function scopeBlock(css: string, attribute: string, renames: ReadonlyMap<string, string>): string {
  let out = ''
  let i = 0

  while (i < css.length) {
    const stop = preludeEnd(css, i)

    if (css[stop] !== '{') {
      const chunk = css.slice(i, stop + 1)

      out += renames.size === 0 ? chunk : animationNames(chunk, renames)
      i = stop + 1

      continue
    }

    const end = closing(css, stop, '{', '}')
    const prelude = css.slice(i, stop)
    const body = css.slice(stop + 1, end)
    const head = prelude.slice(LEADING.exec(prelude)![0].length)
    const at = AT_NAME.exec(head)

    // A custom property's value may hold braces (`--x: { a: b }`), which is a value, not a rule.
    if (head.startsWith('--')) {
      out += css.slice(i, end + 1)
      i = end + 1

      continue
    }

    if (at === null)
      out += `${scopeRule(prelude, attribute)}{${body.includes('{') || renames.size > 0 ? scopeBlock(body, attribute, renames) : body}}`
    else if (KEYFRAMES_AT.test(`@${at[1]}`))
      out += `${keyframesPrelude(prelude, renames)}{${body}}`
    else
      out += `${prelude}{${NESTING.has(at[1]!.toLowerCase()) ? scopeBlock(body, attribute, renames) : body}}`

    i = end + 1
  }

  return out
}

// Ends the last compound of every selector of `css` on `[attribute]`, so its rules reach this component's elements alone. `:global(...)` is left unscoped, and the bodies of `@media`, `@supports`, `@layer` and `@container` are scoped alike, as are the rules nested inside another, whose selector ends on the attribute too (`&` included).
// A `@keyframes` name is scoped as well, with its use in `animation` and `animation-name`; `@keyframes :global(spin)` keeps `spin` as it is.
export function scopeCss(css: string, attribute: string): string {
  const suffix = attribute.replace(DATA_PREFIX, '')

  return scopeBlock(css, attribute, new Map([...keyframeNames(css)].map(name => [name, `${name}-${suffix}`])))
}

// `css` with each comment blanked to spaces, so an offset in it is one in the original.
export function blankComments(css: string): string {
  let out = ''

  for (let i = 0; i < css.length; i++) {
    const char = css[i]!

    if (char === '/' && css[i + 1] === '*') {
      const end = commentEnd(css, i)

      out += css.slice(i, end + 1).replaceAll(NOT_NEWLINE, ' ')
      i = end
    }
    else if (char === '"' || char === '\'') {
      const end = stringEnd(css, i)

      out += css.slice(i, end + 1)
      i = end
    }
    else {
      out += char
    }
  }

  return out
}

export interface StyleRule {
  // The rule's selector list, trimmed, and where it starts in the CSS.
  selector: string
  start: number
}

// The style rules of `css` (comments blanked) in the order written: those inside `@media`, `@supports`, `@layer`, `@container` and the like, and those nested in another rule, included.
export function styleRules(css: string): StyleRule[] {
  const found: StyleRule[] = []
  let i = 0

  while (i < css.length) {
    const stop = preludeEnd(css, i)

    if (css[stop] !== '{') {
      i = stop + 1

      continue
    }

    const end = closing(css, stop, '{', '}')
    const prelude = css.slice(i, stop)
    const lead = LEADING.exec(prelude)![0].length
    const head = prelude.slice(lead)
    const at = AT_NAME.exec(head)

    if (!head.startsWith('--')) {
      if (at === null)
        found.push({ selector: head.trimEnd(), start: i + lead }, ...nested(css, stop + 1, end))
      else if (NESTING.has(at[1]!.toLowerCase()))
        found.push(...nested(css, stop + 1, end))
    }

    i = end + 1
  }

  return found
}

// The rules inside the braces `css` holds from `from` to `to`, placed in the whole CSS.
function nested(css: string, from: number, to: number): StyleRule[] {
  return styleRules(css.slice(from, to)).map(rule => ({ ...rule, start: rule.start + from }))
}

// `css` with the relative `url()` and `@import` it holds, written for a file in `from`, pointing at the same files from `to`.
export function rebaseUrls(css: string, from: string, to: string): string {
  return css.replace(URL_REFERENCE, (whole, quote: string | undefined, url: string | undefined, importQuote: string | undefined, imported: string | undefined) => {
    const target = url ?? imported!

    if (OUTSIDE_FILE.test(target) || (url === undefined && !target.startsWith('.')))
      return whole

    const moved = relative(to, resolve(from, target)).split(sep).join('/')
    const text = moved.startsWith('.') ? moved : `./${moved}`

    return url === undefined ? `@import ${importQuote}${text}${importQuote}` : `url(${quote}${text}${quote})`
  })
}

// The selectors of a list, each trimmed, with where it starts in the list.
export function selectorList(list: string): { text: string, start: number }[] {
  let offset = 0

  return pieces(list, ',').flatMap((part) => {
    const start = offset

    offset += part.length

    const text = part.trim()

    return part === ',' || text === '' ? [] : [{ text, start: start + part.indexOf(text) }]
  })
}
