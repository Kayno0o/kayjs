import type { Span } from './ast'
import type { ImportBinding, ScriptAnalysis } from './script-shared'
import { needsBrowser } from './kay-exports'
import { propsDeclaration, reportMisplacedProps } from './script-props'
import { isExport } from './script-server'
import { plainNames } from './script-shared'
import { splitFence } from './script-split'

// Splits a component script into module-level code (imports, types) and the component body, and finds the props macro.
// `serverNames` are the names the `--- server` fence hands the script, which a type may take the type of.
// `module` is the `--- module` fence, whose code stays at module level beside the script's imports and types.
export function analyzeScript(source: string, script: Span | undefined, serverNames: string[] = [], module?: Span): ScriptAnalysis {
  const analysis = analyzeComponentScript(source, script, serverNames)

  return module === undefined ? analysis : withModule(analysis, analyzeModule(source, module))
}

// The `--- module` fence as module-level code: every statement is hoisted, the exports among them are the file's own.
function analyzeModule(source: string, module: Span): ScriptAnalysis {
  const analysis: ScriptAnalysis = { hoisted: [], imports: [], specifiers: [], body: [], broken: [], brokenModule: [], reactive: false, plain: [], diagnostics: [] }
  const split = splitFence(source, module, [], analysis)

  if (!split)
    return analysis

  analysis.reactive = analysis.imports.some(importsReactiveValue)

  for (const { statement, span } of split.statements) {
    if (propsDeclaration(statement, split.ast.body, split.shift, [])) {
      analysis.diagnostics.push({ ...span, message: 'A `--- module` fence declares no props', help: 'declare them in the component script' })

      continue
    }

    if (statement.type === 'ExportDefaultDeclaration')
      analysis.diagnostics.push({ ...span, message: 'The component is the default export of its file', help: 'export a name instead' })

    analysis.hoisted.push(span)
  }

  return analysis
}

function withModule(script: ScriptAnalysis, module: ScriptAnalysis): ScriptAnalysis {
  return {
    ...script,
    moduleFence: module.fence,
    hoisted: [...script.hoisted, ...module.hoisted].toSorted((a, b) => a.start - b.start),
    imports: [...script.imports, ...module.imports],
    specifiers: [...script.specifiers, ...module.specifiers],
    reactive: script.reactive || module.reactive,
    diagnostics: [...script.diagnostics, ...module.diagnostics],
  }
}

function analyzeComponentScript(source: string, script: Span | undefined, serverNames: string[]): ScriptAnalysis {
  const analysis: ScriptAnalysis = { hoisted: [], imports: [], specifiers: [], body: [], broken: [], brokenModule: [], reactive: false, plain: [], diagnostics: [] }

  if (!script)
    return analysis

  const split = splitFence(source, script, serverNames, analysis, true)

  if (!split)
    return analysis

  const { ast, shift } = split

  analysis.reactive = analysis.imports.some(importsReactiveValue)

  const repeated: Span[] = []

  for (const { statement, span, gap } of split.statements) {
    analysis.body.push(...gap)

    const props = propsDeclaration(statement, ast.body, shift, analysis.diagnostics)

    if (props) {
      if (analysis.props) {
        analysis.diagnostics.push({ ...props.statement, message: 'A component declares its props once', related: [{ ...analysis.props.statement, label: 'declared here first' }] })
        repeated.push(props.statement)
      }
      else {
        analysis.props = props
      }
    }
    else {
      if (isExport(statement))
        analysis.diagnostics.push({ ...span, message: 'A component script exports only types', help: 'move the value to a `.ts` module and import it' })

      analysis.plain.push(...plainNames(statement))
      analysis.body.push(span)
    }
  }

  analysis.body.push(...split.tail)
  analysis.recipe = split.recipes[0]?.name
  analysis.recipeSpan = split.recipes[0]?.span
  analysis.recipeRoot = split.recipes[0]?.root
  analysis.recipeVariants = split.recipes[0]?.variants

  for (const extra of split.recipes.slice(1))
    analysis.diagnostics.push({ ...extra.span, message: 'A component has one recipe', help: 'put its variants in the first `recipe({ ... })`' })

  reportMisplacedProps(ast, analysis, shift, repeated)

  return analysis
}

// The first value that makes the script reactive, as the script names it and where it comes from.
export function reactiveValue(script: ScriptAnalysis): { name: string, source: string } | undefined {
  const binding = script.imports.find(importsReactiveValue)

  return binding && { name: binding.local, source: binding.source }
}

function importsReactiveValue(binding: ImportBinding): boolean {
  if (binding.typeOnly)
    return false

  if (binding.imported === 'default' || binding.imported === '*')
    return binding.source === 'kay' || binding.source === 'kay/i18n'

  return needsBrowser(binding.source, binding.imported)
}

export { codeOf, parseFence } from './script-fence'
export { analyzeServer } from './script-server'
export type { PageSetting, PageSettings, SeparateSetting, ServerAnalysis, ServerData } from './script-server'
export type { ImportBinding, ParsedFence, PropsBinding, PropsDeclaration, ScriptAnalysis } from './script-shared'
