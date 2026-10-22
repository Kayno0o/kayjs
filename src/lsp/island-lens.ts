import type { CodeLens } from './protocol'
import { compileKay } from '../compiler'

function titleOf(island: string | undefined, why: string | undefined): string {
  if (island !== undefined)
    return `Island: ${why ?? 'a live value'}`

  return why === undefined ? 'Static: ships no JavaScript' : `Static unless it passes an island what only an island sends: ${why}`
}

// A lens on the first line of a component saying whether it is an island and why, the same cause `kay build` lists.
export function islandLens(source: string, filename: string): CodeLens[] {
  const { island, why } = compileKay(source, filename)
  const first = { line: 0, character: 0 }

  return [{ range: { start: first, end: first }, command: { title: titleOf(island, why), command: '' } }]
}
