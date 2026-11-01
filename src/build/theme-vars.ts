import { relative } from 'node:path'
import { kayLog } from '../runtime/log'
import { CSS_FILE, findProjectFiles, readText } from './files'

const CODE_FILE = /\.(?:kay|[cm]?[jt]sx?)$/
// A `var(--prefix-${...})`: the static start of a custom property name built at runtime.
const BUILT_VAR = /var\(\s*(--[\w-]+)\$\{/g
const THEME_RULE = /@theme\b([^{;]*)\{/g
const DECLARATION = /(?:^|[;{\s])(--[\w-]+)\s*:/g
const STATIC = /\bstatic\b/

// The `@theme` variables Tailwind writes only when a utility uses them: those of a block not marked `static`.
function themeVariables(css: string): Set<string> {
  const found = new Set<string>()

  for (const rule of css.matchAll(THEME_RULE)) {
    if (STATIC.test(rule[1]!))
      continue

    const start = rule.index + rule[0].length
    let depth = 1
    let end = start

    while (depth > 0 && end < css.length) {
      const char = css[end++]

      if (char === '{')
        depth++
      else if (char === '}')
        depth--
    }

    for (const declaration of css.slice(start, end).matchAll(DECLARATION))
      found.add(declaration[1]!)
  }

  return found
}

// Tells of a custom property read through a name built at runtime, `var(--color-lane-${n})`, whose prefix the app declares in `@theme` while the built CSS holds none of them: Tailwind 4 writes only the `@theme` variables a utility uses, so the read finds nothing.
export async function warnBuiltThemeVariables(root: string, built: readonly string[]): Promise<void> {
  const options = { project: true, ownKayOnly: true }
  const [code, sheets] = await Promise.all([findProjectFiles(root, CODE_FILE, options), findProjectFiles(root, CSS_FILE, options)])
  const declared = new Set<string>()

  for (const sheet of sheets) {
    for (const name of themeVariables(await readText(sheet) ?? ''))
      declared.add(name)
  }

  if (declared.size === 0)
    return

  const told = new Set<string>()

  for (const file of code) {
    const text = await readText(file)

    if (text === undefined || !text.includes('var('))
      continue

    for (const match of text.matchAll(BUILT_VAR)) {
      const prefix = match[1]!

      if (told.has(prefix) || ![...declared].some(name => name.startsWith(prefix)) || built.some(css => css.includes(prefix)))
        continue

      told.add(prefix)
      kayLog('warn', `${relative(root, file)}:${text.slice(0, match.index).split('\n').length} reads a theme variable through a built name (\`var(${prefix}\${...})\`), but Tailwind writes only the \`@theme\` variables a utility uses and the CSS holds none under \`${prefix}\`: declare them in \`@theme static { }\` or in \`:root\``)
    }
  }
}
