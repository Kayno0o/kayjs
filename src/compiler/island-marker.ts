import type { Diagnostic, Fix, KayFile } from './ast'
import { wordEdit } from './deprecated-island'

// The fix of a component passing an island what only an island is sent: `island()` written first in its script, a script opened for a template with none, an `island({ render: 'static' })` made `island()`. None for a component that is an island already or one that renders on the server only.
export function islandFence(file: KayFile): Fix | undefined {
  const title = 'Write `island()`'

  if (file.server !== undefined || file.client !== undefined || file.pin?.kind === 'island')
    return undefined

  if (file.pin !== undefined)
    return { title, edits: file.island === undefined ? [wordEdit(file.scriptLine ?? { start: file.pin.start - 4, end: file.pin.end }, file.pin.end, file.source.slice(0, file.scriptLine?.start ?? 0)), { start: file.script?.start ?? 0, end: file.script?.start ?? 0, text: 'island()\n' }] : [{ start: file.island.span.start, end: file.island.span.end, text: 'island()' }] }

  if (file.scriptLine === undefined || file.script === undefined)
    return { title, edits: [{ start: 0, end: 0, text: '---\nisland()\n---\n' }] }

  return { title, edits: [{ start: file.script.start, end: file.script.start, text: 'island()\n' }] }
}

// A pin on a page, a layout or a special page: they render on the server and are never islands.
export function markerMismatch(pin: NonNullable<KayFile['pin']>, page: boolean): Diagnostic[] {
  if (!page || pin.kind !== 'island')
    return []

  return [{ start: pin.start, end: pin.end, code: 'island-marker', message: 'A page, a layout or a special page renders on the server and is never an island, and `island()` says it is one', note: 'an island is a component a page renders', help: 'delete it, and move what needs the browser to a component of its own', checkOnly: true }]
}
