import type { ImportedSignals } from '../compiler/module-signals'
import type { CodeLens } from './protocol'
import { basename } from 'node:path'
import { compileKay, ROUTE_FILES } from '../compiler'

export interface LensContext {
  // The file is a page, a layout or a special page, rendered by the server and never an island.
  route: boolean
  // Only islands render the component, so it is part of them.
  insideIsland: boolean
  signals?: ImportedSignals | undefined
}

function titleOf(island: string | undefined, why: string | undefined, insideIsland: boolean): string {
  if (island !== undefined)
    return `Island: ${why ?? 'a live value'}`

  if (insideIsland)
    return 'Part of an island: only islands render it'

  return why === undefined ? 'Static: ships no JavaScript' : `Static unless it passes an island what only an island sends: ${why}`
}

// A lens on the first line of a component saying whether it is an island and why, the same cause `kay build` lists; none on a page or a layout.
export function islandLens(source: string, filename: string, context: LensContext = { route: false, insideIsland: false }): CodeLens[] {
  if (context.route || ROUTE_FILES.has(basename(filename)))
    return []

  const { island, why } = compileKay(source, filename, { importedSignals: context.signals })
  const first = { line: 0, character: 0 }

  return [{ range: { start: first, end: first }, command: { title: titleOf(island, why, context.insideIsland), command: '' } }]
}
