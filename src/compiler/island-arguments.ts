import type { Diagnostic, Span } from './ast'
import type { ScriptAnalysis } from './script'

const MESSAGE_KEY = /(?:\b(?:t|wording)\(\s*|\bT\([^)]*?\bkey=)(['"`])([\w.-]+)\1/g

function messageKeys(source: string): string[] {
  return [...new Set(Array.from(source.matchAll(MESSAGE_KEY), match => match[2]!))]
}

// The `island` the `--- module` fence exports: `const` for `export const island = { hydrate, persist }`, the one form the compiler reads, `listed` for any other, `export { island }` included.
export function islandExport(script: ScriptAnalysis): { form: 'const' | 'listed', span: Span } | undefined {
  const fence = script.moduleFence

  for (const statement of fence?.ast.body ?? []) {
    if (statement.type !== 'ExportNamedDeclaration')
      continue

    if (statement.declaration?.type === 'VariableDeclaration' && statement.declaration.declarations.some(declarator => declarator.id.type === 'Identifier' && declarator.id.name === 'island'))
      return { form: 'const', span: fence!.shift(statement) }

    if (statement.specifiers.some(specifier => specifier.exported.type === 'Identifier' ? specifier.exported.name === 'island' : specifier.exported.value === 'island'))
      return { form: 'listed', span: fence!.shift(statement) }
  }

  return undefined
}

// The problem with an `island` export nothing reads: one written any other way than `export const island`, or on a component that is no island.
export function ignoredIslandExport(script: ScriptAnalysis, isIsland: boolean): Diagnostic[] {
  const asked = islandExport(script)

  if (asked?.form === 'listed')
    return [{ ...asked.span, code: 'fence-invalid', message: 'Only `export const island = { hydrate, persist }` is read as what the component asks of its parents', help: 'write it as that declaration' }]

  return asked && !isIsland ? [{ ...asked.span, code: 'fence-invalid', message: 'This component is no island, so nothing reads its `island` export', help: 'write `--- island`, or drop the export' }] : []
}

// The `hydrate` the exported `island` asks for, when it is written as a string.
export function exportedHydrate(script: ScriptAnalysis): string | undefined {
  for (const statement of script.moduleFence?.ast.body ?? []) {
    const declaration = statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'VariableDeclaration' ? statement.declaration.declarations.find(each => each.id.type === 'Identifier' && each.id.name === 'island') : undefined
    const init = declaration?.init?.type === 'TSAsExpression' ? declaration.init.expression : declaration?.init
    const property = init?.type === 'ObjectExpression' ? init.properties.find(each => each.type === 'Property' && each.key.type === 'Identifier' && each.key.name === 'hydrate') : undefined

    if (property?.type === 'Property' && property.value.type === 'Literal' && typeof property.value.value === 'string')
      return property.value.value
  }

  return undefined
}

// The `interactive` of the exported `island`, `{ prop: whether it is on when a use leaves it out }`, read where it is written as an object of booleans.
export function interactiveProps(script: ScriptAnalysis): Record<string, boolean> | undefined {
  for (const statement of script.moduleFence?.ast.body ?? []) {
    const declaration = statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'VariableDeclaration' ? statement.declaration.declarations.find(each => each.id.type === 'Identifier' && each.id.name === 'island') : undefined
    const init = declaration?.init?.type === 'TSAsExpression' ? declaration.init.expression : declaration?.init
    const property = init?.type === 'ObjectExpression' ? init.properties.find(each => each.type === 'Property' && each.key.type === 'Identifier' && each.key.name === 'interactive') : undefined
    const given = property?.type === 'Property' ? property.value : undefined
    const value = given?.type === 'TSAsExpression' ? given.expression : given

    if (value?.type !== 'ObjectExpression')
      continue

    const props: Record<string, boolean> = {}

    for (const each of value.properties) {
      if (each.type === 'Property' && each.key.type === 'Identifier' && each.value.type === 'Literal' && typeof each.value.value === 'boolean')
        props[each.key.name] = each.value.value
    }

    return props
  }

  return undefined
}

// Whether the `--- module` fence has `export const island = { hydrate, persist }`: what the component asks of every parent that uses it.
export function exportsIslandOptions(script: ScriptAnalysis): boolean {
  return islandExport(script)?.form === 'const'
}

// The message keys an island's source names, as the third argument to `island()`, or nothing for an island naming none; the live values it imports go last.
// Under `kay dev` the cause goes last, as the `data-why` the dev tool shows. A component exporting `island` passes it last of all.
export function islandMessages(source: string, client = false, lives: string[] = [], cause?: string, fallback = false, options = false): string {
  const keys = messageKeys(source)

  if (options)
    return `, ${JSON.stringify(keys)}, ${client}, undefined, [${lives.join(', ')}], ${cause === undefined ? 'undefined' : JSON.stringify(cause)}, ${fallback ? 'KayFallback' : 'undefined'}, island`

  if (fallback)
    return `, ${JSON.stringify(keys)}, true, undefined, [${lives.join(', ')}], ${cause === undefined ? 'undefined' : JSON.stringify(cause)}, KayFallback`

  if (lives.length > 0 || cause !== undefined)
    return `, ${JSON.stringify(keys)}, ${client}, undefined, [${lives.join(', ')}]${cause === undefined ? '' : `, ${JSON.stringify(cause)}`}`

  if (client)
    return `, ${JSON.stringify(keys)}, true`

  return keys.length > 0 ? `, ${JSON.stringify(keys)}` : ''
}
