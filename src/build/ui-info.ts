import type * as t from '@babel/types'
import type { KayLibrary } from './libraries'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { parse } from '@babel/parser'
import { offered } from '../check/ui'
import { componentName } from '../compiler'
import { parseKay } from '../compiler/parser'
import { findKayFiles } from './files'
import { classesOf, keyOf } from './ui'

// What the dev tool's Styles tab and the language server tell of a component `src/ui.ts` can restyle, all read from the component's file and the library's theme: nothing here is a list kept by hand.
export interface Token {
  name: string
  value: string
}

export interface StyleInfo {
  name: string
  file: string
  // The base classes of each part, from the literal config of the component's recipe; empty for a part the recipe does not set or a config it cannot read.
  parts: { name: string, classes: string }[]
  variants: Record<string, string[]>
  // Whether the component declares a `recipe()`.
  recipe: boolean
}

const THEME = '@kaynooo/kayjs-ui/theme.css'
const DECLARATION = /^\s*(--[\w-]+)\s*:([^;]+);/gm
const VARIABLE = /--[\w-]+/g
const UTILITY = /(?<=-)kui-([\w-]+)/g
const RECIPE_CALL = /\brecipe\s*\(/
const UTILITY_TRIM = /^-+|-+$/g

const themes = new Map<string, { stamp: string, tokens: Token[] }>()

function realOf(file: string): string {
  try {
    return realpathSync(file)
  }
  catch {
    return file
  }
}

// The custom properties the kayjs-ui theme declares, read again when the file changes; none when the app has not installed it.
export function themeTokens(root: string): Token[] {
  let file: string

  try {
    file = realOf(Bun.resolveSync(THEME, root))
  }
  catch {
    return []
  }

  const stat = statSync(file, { throwIfNoEntry: false })

  if (stat === undefined)
    return []

  const stamp = `${stat.mtimeMs}:${stat.size}`
  const kept = themes.get(file)

  if (kept?.stamp === stamp)
    return kept.tokens

  const seen = new Map<string, string>()

  for (const [, name, value] of readFileSync(file, 'utf8').matchAll(DECLARATION))
    seen.set(name!, value!.trim())

  const tokens = [...seen].map(([name, value]) => ({ name, value }))

  themes.set(file, { stamp, tokens })

  return tokens
}

// The tokens a string of classes names: a `var(--x)` or `(length:--x)` it writes, or the utility of a theme token such as `bg-kui-surface0` for `--color-kui-surface0`.
export function tokensNamedBy(classes: string, tokens: Token[]): Token[] {
  const names = new Set(classes.match(VARIABLE))

  for (const [, utility] of classes.matchAll(UTILITY)) {
    const suffix = `-kui-${utility!.replace(UTILITY_TRIM, '')}`

    for (const token of tokens) {
      if (token.name.endsWith(suffix))
        names.add(token.name)
    }
  }

  return tokens.filter(token => names.has(token.name))
}

function recipeConfig(node: t.Node | null | undefined): t.ObjectExpression | undefined {
  let value = node

  while (value && (value.type === 'TSAsExpression' || value.type === 'TSSatisfiesExpression' || value.type === 'ParenthesizedExpression'))
    value = value.expression

  if (value?.type !== 'CallExpression' || value.callee.type !== 'Identifier' || value.callee.name !== 'recipe')
    return undefined

  const config = value.arguments[0]

  return config?.type === 'ObjectExpression' ? config : undefined
}

// The base classes of each part in the literal `recipe({ parts })` of a component's script: a string is the root's.
export function recipeParts(source: string): Record<string, string> {
  const script = parseKay(source).script
  const found: Record<string, string> = {}

  if (script === undefined)
    return found

  let ast: t.File

  try {
    ast = parse(source.slice(script.start, script.end), { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
  }
  catch {
    return found
  }

  for (const statement of ast.program.body) {
    if (statement.type !== 'VariableDeclaration')
      continue

    for (const declarator of statement.declarations) {
      const config = recipeConfig(declarator.init)
      const parts = config?.properties.find((property): property is t.ObjectProperty => property.type === 'ObjectProperty' && keyOf(property) === 'parts')?.value

      if (parts === undefined)
        continue

      const whole = classesOf(parts)

      if (whole !== undefined) {
        found.root = whole
      }
      else if (parts.type === 'ObjectExpression') {
        for (const property of parts.properties) {
          const name = property.type === 'ObjectProperty' ? keyOf(property) : undefined
          const classes = property.type === 'ObjectProperty' ? classesOf(property.value) : undefined

          if (name !== undefined && classes !== undefined)
            found[name] = classes
        }
      }

      return found
    }
  }

  return found
}

// What a component file offers `src/ui.ts` to restyle; none for a page, a layout, and a component with neither parts nor variants.
export function styleInfo(file: string): StyleInfo | undefined {
  try {
    const found = offered(file)

    if (found === 'page' || found === undefined)
      return undefined

    const source = readFileSync(file, 'utf8')
    const base = recipeParts(source)
    const script = parseKay(source).script

    return { name: componentName(file), file, parts: [...new Set([...found.parts, ...Object.keys(base)])].map(name => ({ name, classes: base[name] ?? '' })), variants: found.variants ?? {}, recipe: script !== undefined && RECIPE_CALL.test(source.slice(script.start, script.end)) }
  }
  catch {
    return undefined
  }
}

// The specifier `src/ui.ts` would import a component of the app by.
export function appSpecifier(root: string, file: string): string {
  return `./${relative(realOf(`${root}/src`), realOf(file)).split(sep).join('/')}`
}

// Every component of the app and its libraries `src/ui.ts` can restyle, each once, with the specifiers it can be keyed by.
type Infos = (StyleInfo & { specifiers: string[] })[]

// How long the components found for completion are trusted, as typing in src/ui.ts asks for them on each key.
const INFOS_LIFETIME = 2000
const infosKept = new Map<string, { at: number, infos: Promise<Infos> }>()

export async function styleInfos(root: string, libraries: KayLibrary[]): Promise<Infos> {
  const kept = infosKept.get(root)

  if (kept !== undefined && Date.now() - kept.at < INFOS_LIFETIME)
    return kept.infos

  const infos = readInfos(root, libraries)

  infosKept.set(root, { at: Date.now(), infos })

  try {
    return await infos
  }
  catch (error) {
    // A failed read is not kept, so the next keystroke reads again.
    if (infosKept.get(root)?.infos === infos)
      infosKept.delete(root)

    throw error
  }
}

async function readInfos(root: string, libraries: KayLibrary[]): Promise<Infos> {
  const found = new Map<string, Infos[number]>()
  const add = (file: string, specifier: string) => {
    const real = realOf(file)
    const kept = found.get(real)

    if (kept !== undefined) {
      kept.specifiers.push(specifier)

      return
    }

    const info = styleInfo(real)

    if (info !== undefined)
      found.set(real, { ...info, specifiers: [specifier] })
  }

  for (const file of await findKayFiles(`${root}/src`))
    add(file, appSpecifier(root, file))

  for (const library of libraries) {
    for (const [specifier, file] of library.specifiers)
      add(file, specifier)
  }

  return [...found.values()]
}
