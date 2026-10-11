import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const COMMENT = /\/\*[\s\S]*?\*\//g
const DECLARATION = /(--[\w-]+)\s*:([^;{}]*)/g
const VARIABLE = /var\(\s*(--[\w-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g
const OPAQUE = 255

// Reads the colours an app's mail settings take from its site's stylesheet, whose custom properties mail clients cannot: `colour('--brand')` gives the property's first declaration in the file, its `var()`s followed, as a hex colour, so the dark colours derive from it. A file that cannot be read, or a property missing or no opaque colour, throws naming it as the server boots.
export function cssColours(file: string | URL): (property: string) => string {
  const path = file instanceof URL ? fileURLToPath(file) : file
  let css: string

  try {
    css = readFileSync(path, 'utf8')
  }
  catch {
    throw new Error(`kayjs-mail: the mail settings take their colours from ${path}, which cannot be read; a server built with \`kay build --compile\` carries no source file to read`)
  }

  const declared = new Map<string, string>()

  for (const [, name, value] of css.replace(COMMENT, '').matchAll(DECLARATION)) {
    if (!declared.has(name!))
      declared.set(name!, value!.trim())
  }

  const resolve = (property: string, seen: string[]): string => {
    const value = declared.get(property)

    if (value === undefined)
      throw new Error(`kayjs-mail: ${[...seen, property].join(' -> ')} is not declared in ${path}`)

    if (seen.includes(property))
      throw new Error(`kayjs-mail: ${[...seen, property].join(' -> ')} in ${path} refers to itself`)

    return value.replace(VARIABLE, (_, inner: string, fallback: string | undefined) => declared.has(inner) || fallback === undefined ? resolve(inner, [...seen, property]) : fallback.trim())
  }

  return (property) => {
    const value = resolve(property, [])
    const rgba = Bun.color(value, '[rgba]')

    if (rgba === null)
      throw new Error(`kayjs-mail: ${property} in ${path} is ${value}, which is no colour`)

    if (rgba[3] !== OPAQUE)
      throw new Error(`kayjs-mail: ${property} in ${path} is ${value}, a colour seen through, which mail clients show unevenly; give the mail an opaque one`)

    return Bun.color(value, 'hex')!
  }
}
