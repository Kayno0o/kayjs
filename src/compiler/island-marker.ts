import type { Diagnostic, Fix, KayFile } from './ast'

const SCRIPT_HEADER = /^---(?:[ \t]+script)?/

// The fix of a component passing an island what only an island is sent: its script fence line written `--- island`, a fence opened for a template with none, a `--- static` made `--- island`. None for a component that is an island already or one that renders on the server only.
export function islandFence(file: KayFile): Fix | undefined {
  const title = 'Write `--- island`'

  if (file.server !== undefined || file.client !== undefined || file.pin?.kind === 'island')
    return undefined

  if (file.pin !== undefined)
    return { title, edits: [{ start: file.pin.start, end: file.pin.end, text: 'island' }] }

  const line = file.scriptLine

  if (line === undefined)
    return { title, edits: [{ start: 0, end: 0, text: '--- island\n---\n' }] }

  const named = SCRIPT_HEADER.exec(file.source.slice(line.start, line.end))

  if (named === null)
    return undefined

  return { title, edits: [{ start: line.start, end: line.start + named[0].length, text: '--- island' }] }
}

// A pin on a page, a layout or a special page: they render on the server and are never islands.
export function markerMismatch(pin: NonNullable<KayFile['pin']>, page: boolean): Diagnostic[] {
  if (!page || pin.kind !== 'island')
    return []

  return [{ start: pin.start, end: pin.end, code: 'island-marker', message: 'A page, a layout or a special page renders on the server and is never an island, and `--- island` says it is one', note: 'an island is a component a page renders', help: 'delete it, and move what needs the browser to a component of its own', checkOnly: true }]
}
