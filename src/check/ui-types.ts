import type { KayLibrary } from '../build/libraries'
import { realpathSync } from 'node:fs'
import { dirname, relative, sep } from 'node:path'
import { componentsNamed, forgetNames, uiOf } from '../build/ui'
import { componentName } from '../compiler'
import { offered } from './ui'

interface Shape {
  parts: string[]
  variants: Record<string, string[]>
}

const union = (names: string[]) => names.length === 0 ? 'never' : names.map(name => JSON.stringify(name)).join(' | ')

function typeOf(shape: Shape): string {
  const variants = Object.entries(shape.variants).map(([name, values]) => `${JSON.stringify(name)}: ${union(values)}`)

  return `{ parts: ${union(shape.parts)}, variants: { ${variants.join(', ')} } }`
}

function realOf(file: string): string {
  try {
    return realpathSync(file)
  }
  catch {
    return file
  }
}

// The `UiComponents` of `kay`, declared from the components `src/ui.ts` can restyle: each by the name a template calls it and by its specifier, with its part names and the values of its variants, so `defineUi` completes and checks an entry in the editor. An app with no `src/ui.ts` declares none.
export function uiTypes(root: string, libraries: KayLibrary[], own: string[]): string {
  const ui = uiOf(root)

  if (ui === undefined)
    return 'export {}\n'

  forgetNames(ui)

  const from = realOf(dirname(ui.file))
  const shapes = new Map<string, Shape>()
  const specifiers = new Map<string, string>()

  const shapeOf = (file: string): Shape | undefined => {
    const real = realOf(file)

    if (!shapes.has(real)) {
      try {
        const found = offered(real)

        if (found !== 'page' && found !== undefined)
          shapes.set(real, { parts: [...found.parts], variants: found.variants ?? {} })
      }
      catch {}
    }

    return shapes.get(real)
  }

  for (const file of own.map(realOf)) {
    if (file.startsWith(from + sep) && shapeOf(file) !== undefined)
      specifiers.set(`./${relative(from, file).split(sep).join('/')}`, file)
  }

  for (const library of libraries) {
    for (const [specifier, file] of library.specifiers) {
      if (shapeOf(file) !== undefined)
        specifiers.set(specifier, realOf(file))
    }
  }

  const entries = new Map<string, Shape>()

  for (const file of new Set(specifiers.values())) {
    const name = componentName(file)
    const matches = componentsNamed(ui, name)

    if (matches.length === 1 && matches[0] === file)
      entries.set(name, shapes.get(file)!)
  }

  for (const [specifier, file] of specifiers)
    entries.set(specifier, shapes.get(file)!)

  const lines = [...entries].map(([key, shape]) => `    ${JSON.stringify(key)}: ${typeOf(shape)}`)

  return `export {}\n\ndeclare module 'kay' {\n  interface UiComponents {\n${lines.join('\n')}\n  }\n}\n`
}
