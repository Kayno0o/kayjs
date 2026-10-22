import { relative, resolve, sep } from 'node:path'

const LEADING = /^(?:\s|\/\*[\s\S]*?\*\/)*/
const AT_NAME = /^@([\w-]+)/
const GLOBAL = ':global('
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
  return Bun.hash(moduleId).toString(36)
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

// `compound` with each `:global(...)` unwrapped, and whether anything of this component's is left: the pseudo-classes and pseudo-elements after a leading `:global(...)` belong to it.
function unwrapped(compound: string): { text: string, own: boolean } {
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

  return { text, own: ownText !== '' && !(compound.startsWith(GLOBAL) && ownText.startsWith(':')) }
}

// Where a pseudo-element starts in `compound`, outside brackets and strings, or its end.
function pseudoElementAt(compound: string): number {
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

function scopeSelector(selector: string, attribute: string): string {
  const parts = pieces(selector, ' \t\r\n>+~').map(part => part.length === 1 && ' \t\r\n>+~'.includes(part) ? { text: part, own: false, combinator: true } : { ...unwrapped(part), combinator: false })
  const target = parts.findLastIndex(part => !part.combinator && part.own)

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

// Ends the last compound of every selector of `css` on `[attribute]`, so its rules reach this component's elements alone. `:global(...)` is left unscoped, and the bodies of `@media`, `@supports`, `@layer` and `@container` are scoped alike, as are the rules nested inside another, whose selector ends on the attribute too (`&` included).
export function scopeCss(css: string, attribute: string): string {
  let out = ''
  let i = 0

  while (i < css.length) {
    const stop = preludeEnd(css, i)

    if (css[stop] !== '{') {
      out += css.slice(i, stop + 1)
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

    out += at === null ? `${scopeRule(prelude, attribute)}{${body.includes('{') ? scopeCss(body, attribute) : body}}` : `${prelude}{${NESTING.has(at[1]!.toLowerCase()) ? scopeCss(body, attribute) : body}}`

    i = end + 1
  }

  return out
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
