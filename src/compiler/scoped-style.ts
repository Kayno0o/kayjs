const LEADING = /^(?:\s|\/\*[\s\S]*?\*\/)*/
const AT_NAME = /^@([\w-]+)/
const GLOBAL = ':global('
const PSEUDO_ELEMENT = /::|:(?:before|after|first-line|first-letter)\b/
// At-rules whose body holds style rules of the same page.
const NESTING = new Set(['media', 'supports', 'layer', 'container', 'document'])

// The attribute a component with a `--- style` fence puts on every element its template writes, and its selectors end on.
export function scopeAttribute(moduleId: string): string {
  return `data-k-${Bun.hash(moduleId).toString(36).slice(0, 8)}`
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

// `compound` with each `:global(...)` unwrapped, and whether anything else is left.
function unwrapped(compound: string): { text: string, own: boolean } {
  let text = ''
  let own = false
  let i = 0

  while (i < compound.length) {
    if (compound.startsWith(GLOBAL, i)) {
      const end = closing(compound, i + GLOBAL.length - 1, '(', ')')

      text += compound.slice(i + GLOBAL.length, end)
      i = end + 1
    }
    else {
      text += compound[i]
      own = true
      i++
    }
  }

  return { text, own }
}

function scopeSelector(selector: string, attribute: string): string {
  const parts = pieces(selector, ' \t\r\n>+~').map(part => part.length === 1 && ' \t\r\n>+~'.includes(part) ? { text: part, own: false, combinator: true } : { ...unwrapped(part), combinator: false })
  const target = parts.findLastIndex(part => !part.combinator && part.own)

  return parts.map((part, index) => {
    if (index !== target)
      return part.text

    const pseudo = PSEUDO_ELEMENT.exec(part.text)?.index ?? part.text.length

    return `${part.text.slice(0, pseudo)}[${attribute}]${part.text.slice(pseudo)}`
  }).join('')
}

function scopeRule(prelude: string, attribute: string): string {
  const lead = LEADING.exec(prelude)![0]
  const selectors = pieces(prelude.slice(lead.length), ',')

  return lead + selectors.map(selector => selector === ',' ? selector : scopeSelector(selector, attribute)).join('')
}

// Ends the last compound of every selector of `css` on `[attribute]`, so its rules reach this component's elements alone. `:global(...)` is left unscoped, and the bodies of `@media`, `@supports`, `@layer` and `@container` are scoped alike.
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
    const at = AT_NAME.exec(prelude.slice(LEADING.exec(prelude)![0].length))

    out += at === null ? `${scopeRule(prelude, attribute)}{${body}}` : `${prelude}{${NESTING.has(at[1]!.toLowerCase()) ? scopeCss(body, attribute) : body}}`

    i = end + 1
  }

  return out
}
