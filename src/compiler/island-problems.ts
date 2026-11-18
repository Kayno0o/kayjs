import type { Diagnostic, KayFile } from './ast'
import { declaredIsland } from './island-declaration'

const MEDIA_HYDRATE = /^media\(\s*\S.*\)$/s

// What is wrong with a static `hydrate` value on a use: `client` is `render="client"` since 1.105, and `media(...)` needs a query.
export function hydrateProblem(text: string): [message: string, details: { help: string }] | undefined {
  if (text === 'client')
    return ['`hydrate="client"` is `render="client"`', { help: 'write `render="client"` to render the component in the browser only' }]

  if (text.startsWith('media(') && !MEDIA_HYDRATE.test(text))
    return ['`hydrate="media(...)"` needs a media query', { help: 'write the query in the brackets: `hydrate="media(max-width: 40rem)"`' }]

  return undefined
}

// The line ending a file writes, which what a fix inserts follows.
export const eolOf = (source: string): string => source.includes('\r\n') ? '\r\n' : '\n'

// An `island()` call in a `--- module` fence, which declares nothing there: the call belongs to the component's script.
export function islandProblems(file: KayFile): Diagnostic[] {
  const declared = file.module === undefined ? undefined : declaredIsland(file.source, file.module)

  return declared === undefined ? [] : [{ ...declared.span, code: 'fence-invalid', message: '`island()` goes in the component\'s script, not its `--- module` fence', help: 'move it to the top of the script fence' }]
}
