import type { ScriptAnalysis } from './script'

const MESSAGE_KEY = /(?:\b(?:t|wording)\(\s*|\bT\([^)]*?\bkey=)(['"`])([\w.-]+)\1/g

function messageKeys(source: string): string[] {
  return [...new Set(Array.from(source.matchAll(MESSAGE_KEY), match => match[2]!))]
}

// Whether the `--- module` fence has `export const island = { hydrate, persist }`: what the component asks of every parent that uses it.
export function exportsIslandOptions(script: ScriptAnalysis): boolean {
  return script.moduleFence?.ast.body.some(statement => statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'VariableDeclaration' && statement.declaration.declarations.some(declarator => declarator.id.type === 'Identifier' && declarator.id.name === 'island')) === true
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
