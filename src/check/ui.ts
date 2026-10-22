import type { CheckDiagnostic } from '.'
import type { UiComponent, UiSource } from '../build/ui'
import type { Diagnostic, Span } from '../compiler/ast'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { componentFile, KAY_EXTENSION, uiOf } from '../build/ui'
import { ROUTE_FILES } from '../compiler'
import { templateFacts } from '../compiler/ast'
import { parseKay } from '../compiler/parser'
import { analyzeScript } from '../compiler/script'
import { fromCompile } from './shadow-types'

function listed(names: Iterable<string>): string {
  return [...names].map(name => `\`${name}\``).join(', ')
}

// What a component offers `src/ui.ts` to set: its parts, and the variants of its recipe with their values; none of either when it declares neither, and `page` for a page or a layout, which the build gives no entry.
function offered(file: string): { parts: Set<string>, variants: Record<string, string[]> | undefined } | 'page' | undefined {
  const source = readFileSync(file, 'utf8')
  const parsed = parseKay(source)

  if (parsed.server !== undefined || ROUTE_FILES.has(basename(file)))
    return 'page'

  const script = analyzeScript(source, parsed.script, [], [], parsed.module)
  const parts = templateFacts(parsed, script.recipe).parts

  return parts?.merges === true ? { parts: new Set(parts.names.keys()), variants: script.recipe === undefined ? {} : script.recipeVariants } : undefined
}

function componentProblems(ui: UiSource, component: UiComponent, report: (span: Span, message: string, help?: string) => void): void {
  const file = componentFile(ui, component)

  if (file === undefined) {
    report(component.span, `\`${component.specifier}\` names no component`, KAY_EXTENSION.test(component.specifier) ? 'write the specifier src/ui.ts would import the component with: a package\'s path, or a path relative to src/ui.ts' : 'a component is a `.kay` file')

    return
  }

  const found = offered(file)

  if (found === 'page') {
    report(component.span, `\`${component.specifier}\` is a page, a layout or a component with a \`--- server\` fence`, 'those take no entry in src/ui.ts: a page has no `class` prop to merge it into')

    return
  }

  if (found === undefined) {
    report(component.span, `\`${component.specifier}\` has no parts or variants to restyle`, 'a component offers its parts with `part="head"` and its variants with `recipe()`')

    return
  }

  for (const part of component.parts) {
    if (!found.parts.has(part.name))
      report(part.span, `\`${component.specifier}\` has no part \`${part.name}\``, `its parts are ${listed(found.parts)}`)
  }

  if (found.variants === undefined)
    return

  for (const variant of component.variants) {
    const values = Object.hasOwn(found.variants, variant.name) ? found.variants[variant.name]! : undefined

    if (values === undefined) {
      report(variant.span, `\`${component.specifier}\` has no variant \`${variant.name}\``, Object.keys(found.variants).length === 0 ? 'a variant restyles one the component\'s `recipe()` declares, and it declares none' : `its variants are ${listed(Object.keys(found.variants))}`)

      continue
    }

    for (const value of variant.values) {
      if (!values.includes(value.name))
        report(value.span, `The variant \`${variant.name}\` of \`${component.specifier}\` has no value \`${value.name}\``, `its values are ${listed(values)}`)
    }
  }
}

// What `src/ui.ts` sets that the components it names do not have: an unknown component, part, variant or value, and a file the compiler cannot read as written.
export function uiProblems(root: string): CheckDiagnostic[] {
  const ui = uiOf(root)

  if (ui === undefined)
    return []

  const found: Diagnostic[] = [...ui.problems]
  const report = (span: Span, message: string, help?: string) => found.push({ ...span, message, help })

  const named = new Map<string, UiComponent>()

  for (const component of ui.components) {
    const file = componentFile(ui, component)
    const first = file === undefined ? undefined : named.get(file)

    if (first !== undefined)
      report(component.span, `\`${component.specifier}\` names the same component as \`${first.specifier}\``, 'only the last entry applies: write one')
    else if (file !== undefined)
      named.set(file, component)

    componentProblems(ui, component, report)
  }

  return found.map(diagnostic => fromCompile(ui.file, ui.source, diagnostic))
}
