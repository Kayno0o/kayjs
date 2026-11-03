import type { ImportedSignals } from '../compiler/module-signals'
import type { CodeLens } from './protocol'
import { basename } from 'node:path'
import { compileKay, ROUTE_FILES } from '../compiler'
import { describeCause } from '../compiler/island-cause'
import { toPosition } from './positions'

// Run by a click on the lens: the editor shows the line that makes the component an island. Each server registers it under its own root, as an editor with several servers registers every command a server lists and refuses one twice.
export function revealCommand(root: string): string {
  return `kay.revealIslandCause:${root}`
}

export interface LensContext {
  // The file is a page, a layout or a special page, rendered by the server and never an island.
  route: boolean
  // Only islands render the component, so it is part of them.
  insideIsland: boolean
  signals?: ImportedSignals | undefined
  // The command revealing the cause in the document, which the editor runs on a click; none for an editor that cannot show a document.
  reveal?: { command: string, uri: string } | undefined
}

function titleOf(island: string | undefined, cause: string | undefined, insideIsland: boolean): string {
  if (island !== undefined)
    return `Island: ${cause ?? 'a live value'}`

  if (insideIsland)
    return 'Part of an island: only islands render it'

  return cause === undefined ? 'Static: ships no JavaScript' : `Static unless it passes an island what only an island sends: ${cause}`
}

// A lens on the first line of a component saying whether it is an island and why, the same cause `kay build` lists, and revealing it on a click; none on a page or a layout.
export function islandLens(source: string, filename: string, context: LensContext = { route: false, insideIsland: false }): CodeLens[] {
  if (context.route || ROUTE_FILES.has(basename(filename)))
    return []

  const { island, cause } = compileKay(source, filename, { importedSignals: context.signals })
  const first = { line: 0, character: 0 }
  const title = titleOf(island, cause && describeCause(cause), context.insideIsland)
  const reveal = cause !== undefined && !context.insideIsland ? context.reveal : undefined

  return [{ range: { start: first, end: first }, command: { title, command: reveal?.command ?? '', ...reveal && cause && { arguments: [reveal.uri, { start: toPosition(source, cause.span.start), end: toPosition(source, cause.span.end) }] } } }]
}
