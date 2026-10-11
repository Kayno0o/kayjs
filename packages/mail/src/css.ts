import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const COMMENT = /\/\*[\s\S]*?\*\//g
const DECLARATION = /(?<![\w-])(--[\w-]+)\s*:([^;{}]*)/g
const VARIABLE = /var\(\s*(--[\w-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g
const OPAQUE = 255

// The text of the stylesheet a URL points at, read as the server boots.
function read(file: URL): string {
  const path = fileURLToPath(file)

  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    throw new Error(`kayjs-mail: the mail settings take their colours from ${path}, which cannot be read; a server built with \`kay build --compile\` carries no source file, so import the stylesheet's text with \`with { type: 'text' }\` instead`)
  }
}

// The colours of a stylesheet's custom properties, given its text, `import css from './global.css' with { type: 'text' }`, or a URL to read it from: `colour('--brand')` gives the property's first declaration, its `var()`s followed, as hex. A file that cannot be read, or a property missing or no opaque colour, throws naming the stylesheet, as `name` calls a text.
export function cssColours(stylesheet: string | URL, name = 'the stylesheet'): (property: string) => string {
  const [css, named] = stylesheet instanceof URL ? [read(stylesheet), fileURLToPath(stylesheet)] : [stylesheet, name]
  const declared = new Map<string, string>()

  for (const [, property, value] of css.replace(COMMENT, '').matchAll(DECLARATION)) {
    if (!declared.has(property!))
      declared.set(property!, value!.trim())
  }

  // Each `var()` in `text` replaced by its property's value, else its fallback, both followed in turn.
  function expand(text: string, seen: string[]): string {
    return text.replace(VARIABLE, (_, inner: string, fallback: string | undefined) => declared.has(inner) || fallback === undefined ? resolve(inner, seen) : expand(fallback.trim(), seen))
  }

  function resolve(property: string, seen: string[]): string {
    const value = declared.get(property)

    if (value === undefined)
      throw new Error(`kayjs-mail: ${[...seen, property].join(' -> ')} is not declared in ${named}`)

    if (seen.includes(property))
      throw new Error(`kayjs-mail: ${[...seen, property].join(' -> ')} in ${named} refers to itself`)

    return expand(value, [...seen, property])
  }

  return (property) => {
    const value = resolve(property, [])
    const rgba = Bun.color(value, '[rgba]')

    if (rgba === null)
      throw new Error(`kayjs-mail: ${property} in ${named} is ${value}, which is no colour`)

    if (rgba[3] !== OPAQUE)
      throw new Error(`kayjs-mail: ${property} in ${named} is ${value}, a colour seen through, which mail clients show unevenly; give the mail an opaque one`)

    return Bun.color(value, 'hex')!
  }
}
