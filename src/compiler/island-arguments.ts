import type { Diagnostic } from './ast'
import type { AwaitAlert } from './names'
import type { ScriptAnalysis } from './script'
import { AWAIT_FAILED_KEY } from '../runtime/await-failed'
import { BUTTON_FORM_KEY } from '../runtime/button-form'

const MESSAGE_KEY = /(?:\b(?:t|T|wording)\(\s*|\bT\([^)]*?\bkey=)(['"`])([\w.-]+)\1/g

export const AWAIT_LINE = /^[ \t]*await\b/m
const KAY_IMPORT = /\bfrom\s+(['"])[^'"]+\.kay\1/

// What the source words by key, and the alert an `await` may show, its own or one in a component it renders, which the browser words as the server does.
export function messageKeys(source: string): string[] {
  const keys = Array.from(source.matchAll(MESSAGE_KEY), match => match[2]!)

  return [...new Set(AWAIT_LINE.test(source) || KAY_IMPORT.test(source) ? [...keys, AWAIT_FAILED_KEY] : keys)]
}

// The source with the keys of the app's `await-failed.kay` added, as an island that may show it words them too.
export function withAlertKeys(source: string, alert: AwaitAlert | undefined): string {
  return alert === undefined || (!AWAIT_LINE.test(source) && !KAY_IMPORT.test(source)) ? source : `${source}\n${alert.keys.map(key => `t('${key}')`).join(' ')}`
}

// An `island` exported by the `--- module` fence, which nothing reads: a component says what it asks of its parents with `island({ hydrate, persist, interactive })` in its script.
export function ignoredIslandExport(script: ScriptAnalysis): Diagnostic[] {
  for (const statement of script.moduleFence?.ast.body ?? []) {
    if (statement.type !== 'ExportNamedDeclaration')
      continue

    const named = statement.declaration?.type === 'VariableDeclaration' && statement.declaration.declarations.some(declarator => declarator.id.type === 'Identifier' && declarator.id.name === 'island')
    const listed = statement.specifiers.some(specifier => specifier.exported.type === 'Identifier' ? specifier.exported.name === 'island' : specifier.exported.value === 'island')

    if (named || listed)
      return [{ ...script.moduleFence!.shift(statement), code: 'fence-invalid', message: 'A component declares `island({ hydrate, persist, interactive })` first in its script, and its `--- module` fence exports no `island`', help: 'write the call at the top of the script and drop the export' }]
  }

  return []
}

// The message keys an island's source names, as the third argument to `island()`, with the flag of a lone button's form when it writes one, or nothing for an island naming none; the live values it imports go last.
// Under `kay dev` the cause goes last, as the `data-why` the dev tool shows. A component exporting `island` passes it last of all.
export function islandMessages(source: string, client = false, lives: string[] = [], cause?: string, fallback = false, options: string | false = false, wrapsButtons = false): string {
  const keys = wrapsButtons ? [...messageKeys(source), BUTTON_FORM_KEY] : messageKeys(source)

  if (options !== false)
    return `, ${JSON.stringify(keys)}, ${client}, undefined, [${lives.join(', ')}], ${cause === undefined ? 'undefined' : JSON.stringify(cause)}, ${fallback ? 'KayFallback' : 'undefined'}, ${options}`

  if (fallback)
    return `, ${JSON.stringify(keys)}, true, undefined, [${lives.join(', ')}], ${cause === undefined ? 'undefined' : JSON.stringify(cause)}, KayFallback`

  if (lives.length > 0 || cause !== undefined)
    return `, ${JSON.stringify(keys)}, ${client}, undefined, [${lives.join(', ')}]${cause === undefined ? '' : `, ${JSON.stringify(cause)}`}`

  if (client)
    return `, ${JSON.stringify(keys)}, true`

  return keys.length > 0 ? `, ${JSON.stringify(keys)}` : ''
}
