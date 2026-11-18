import type { Diagnostic, KayFile } from './ast'
import { declaredIsland } from './island-declaration'

// The line ending a file writes, which what a fix inserts follows.
export const eolOf = (source: string): string => source.includes('\r\n') ? '\r\n' : '\n'

// An `island()` call in a `--- module` fence, which declares nothing there: the call belongs to the component's script.
export function islandProblems(file: KayFile): Diagnostic[] {
  const declared = file.module === undefined ? undefined : declaredIsland(file.source, file.module)

  return declared === undefined ? [] : [{ ...declared.span, code: 'fence-invalid', message: '`island()` goes in the component\'s script, not its `--- module` fence', help: 'move it to the top of the script fence' }]
}
