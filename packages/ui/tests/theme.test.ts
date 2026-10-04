import { describe, expect, test } from 'bun:test'
import { compileKay } from 'kay/compiler'

const ROOT = new URL('..', import.meta.url).pathname

// These list today's families of token names: a class reaching for a new family needs it added here too.
const COLOR = /\b(?:bg|text|border|ring|ring-offset|fill|stroke|outline|caret)-(text|muted|mantle|canvas|surface\d|overlay\d|subtext\d|accent(?:-hi)?|on-accent|error|success|row-hover|fill-hover|fill-danger)\b/g
const SCALE = /\b(gap|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|text|font|tracking|rounded)-(section|inline|micro|2xs|heading|label|action|card)\b/g
const DEFINED_TOKEN = /(--[\w-]+):/g
const DEFINED_CLASS = /\.([a-z][\w-]*)/g
// A `class` attribute: a quoted string, or an expression of strings, arrays and `{ name: condition }` objects.
const CLASS_STRING_ATTRIBUTE = /\bclass="([^"]*)"/g
const CLASS_EXPRESSION = /\bclass=\{((?:[^{}]|\{[^{}]*\})*)\}/g
// A class name in an expression: a quoted string, unless a comparison makes it a value, or an object key.
const CLASS_IN_EXPRESSION = /([!=]==\s*)?'([a-z][\w-]*)'|\b([a-z][\w-]*)(?=\s*:)/g
const WHITESPACE = /\s+/

// The theme namespace a scale utility reads, by its prefix.
const NAMESPACE: Record<string, string> = { text: 'text', font: 'font-weight', tracking: 'tracking', rounded: 'radius' }

for (const prefix of ['gap', 'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr', 'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr'])
  NAMESPACE[prefix] = 'spacing'

const theme = await Bun.file(`${ROOT}src/theme.css`).text()
const paths = await Array.fromAsync(new Bun.Glob('src/**/*.kay').scan({ cwd: ROOT }))
const components = await Promise.all(paths.map(async path => ({ path, source: await Bun.file(`${ROOT}${path}`).text() })))

const tokens = new Set([...theme.matchAll(DEFINED_TOKEN)].map(([, token]) => token))
const classes = new Set([...theme.matchAll(DEFINED_CLASS)].map(([, name]) => name))

// Every class a component writes: the `.class` shorthand, plain `class` attributes, and the names a `class` expression holds.
function writtenClasses(path: string, source: string): string[] {
  const template = source.slice(source.lastIndexOf('\n---\n') + 1)
  const plain = [...template.matchAll(CLASS_STRING_ATTRIBUTE)].flatMap(([, value = '']) => value.split(WHITESPACE))
  const expressions = [...template.matchAll(CLASS_EXPRESSION)].flatMap(([, expression = '']) => [...expression.matchAll(CLASS_IN_EXPRESSION)].filter(([, compared]) => compared === undefined).map(([, , quoted, key]) => quoted ?? key!))

  return [...compileKay(source, path).classes, ...plain, ...expressions].filter(Boolean)
}

describe('theme.css', () => {
  test('defines every colour its classes paint with', () => {
    const used = new Set([...theme.matchAll(COLOR)].map(([, name]) => `--color-${name}`))

    expect([...used].filter(token => !tokens.has(token))).toEqual([])
  })

  test('defines every size, weight, tracking and spacing its classes use beyond Tailwind\'s own', () => {
    const used = new Set([...theme.matchAll(SCALE)].map(([, prefix = '', name]) => `--${NAMESPACE[prefix]}-${name}`))

    expect([...used].filter(token => !tokens.has(token))).toEqual([])
  })

  test('defines every class a component writes, so no component carries a utility an app could not restyle', () => {
    const written = new Set(components.flatMap(({ path, source }) => writtenClasses(path, source)))

    expect(written.size).toBeGreaterThan(0)
    expect([...written].filter(name => !classes.has(name))).toEqual([])
  })

  test('declares its tokens as defaults, so the app\'s own @theme wins wherever it sits', () => {
    expect(theme).toContain('@theme default {')
    expect(theme).not.toContain('@theme {')
  })
})
