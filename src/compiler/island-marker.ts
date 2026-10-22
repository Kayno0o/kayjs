import type { Diagnostic, Span } from './ast'

// `// kay-island` or `// kay-static` on a line of its own says what the author expects of the component, which `kay check` holds it to.
const MARKER = /^[ \t]*\/\/[ \t]*kay-(island|static)[ \t]*$/m

export interface IslandMarker extends Span {
  kind: 'island' | 'static'
}

export function islandMarker(source: string): IslandMarker | undefined {
  const found = MARKER.exec(source)

  return found === null ? undefined : { kind: found[1] as IslandMarker['kind'], start: found.index, end: found.index + found[0].length }
}

function mismatch(marker: IslandMarker, message: string, note: string, help: string): Diagnostic {
  return { start: marker.start, end: marker.end, code: 'island-marker', message, note, help, checkOnly: true }
}

// What a marker says against what makes the component an island, `why` being the first cause when it is one, `promotion` the call that may promote it.
export function markerMismatch(marker: IslandMarker, role: { route: boolean, island: boolean, why: string | undefined, promotion: string | undefined }): Diagnostic[] {
  if (marker.kind === 'static')
    return role.island ? [mismatch(marker, `This component is an island, and \`// kay-static\` says it is not: ${role.why ?? 'a live value'}`, 'it renders on the server and hydrates in the browser', 'delete the marker, or take out what makes it one')] : []

  if (role.route)
    return [mismatch(marker, 'A page, a layout or a special page renders on the server and is never an island', 'an island is a component a page renders', 'delete the marker, and move what needs the browser to a component of its own')]

  if (!role.island && role.promotion === undefined)
    return [mismatch(marker, 'Nothing makes this component an island, and `// kay-island` says it is one', 'an island has an `on*` handler, a `bind:`, a `ref`, a value used from `kay` or a `--- client` fence', 'delete the marker, or add what the component does in the browser')]

  return []
}
