import type { Span } from './ast'

// What makes a component an island, or may make a static one render as one: where it sits in the file and what it is, for the editor, `kay build`, `kay explain island` and the dev tool to say the same thing.
export type IslandCauseKind = 'client' | 'attribute' | 'value' | 'live' | 'prop' | 'spread' | 'block'

export interface IslandCause {
  kind: IslandCauseKind
  // The attribute (`onClick`, `bind:value`, `ref`), the `kay` value (`signal`), the live value or the prop; `--- client` for the fence, empty for a spread or a block.
  name: string
  // Where it is in the file, which the editor reveals.
  span: Span
  // The 1-based line of the span.
  line: number
  // The `kay` value's module, as `kay`.
  source?: string | undefined
  // The component a function, a spread or a block is passed to.
  target?: string | undefined
}

// The sentence of `kay build`, the lints and the lens.
export function describeCause(cause: IslandCause): string {
  switch (cause.kind) {
    case 'client':
      return 'a `--- client` fence'
    case 'attribute':
      return `\`${cause.name}\`, line ${cause.line}`
    case 'value':
      return `\`${cause.name}\` from ${cause.source}`
    case 'live':
      return `\`${cause.name}\`, a live value`
    case 'prop':
      return `\`${cause.name}\` passed to ${cause.target}, line ${cause.line}`
    case 'spread':
      return `a spread passed to ${cause.target}, line ${cause.line}`
    case 'block':
      return `a block taking parameters passed to ${cause.target}, line ${cause.line}`
  }
}

// What the cause is, in a few words.
export const CAUSE_KINDS: Record<IslandCauseKind, string> = {
  client: 'a `--- client` fence: the component renders in the browser only',
  attribute: 'an `on*`, `bind:` or `ref` attribute: the browser handles it',
  value: 'a `kay` value of the browser, such as `signal` or `effect`, that its script uses',
  live: 'a live value its script imports: the browser follows it',
  prop: 'a function or a class instance passed to a component, which only an island can send',
  spread: 'a spread passed to a component, which may hold a function',
  block: 'a block taking parameters passed to a component, which only an island can send',
}

// The rule, as `kay explain island` says it.
export const ISLAND_RULE = 'A component is an island when it needs the browser: an `on*`, `bind:` or `ref` in its template, a browser value of `kay` in its script, a live value it imports or a `--- client` fence; what an island renders is part of it. A static component that passes a component a function, a spread or a block taking parameters renders as an island too, when the build finds the chunk reachable.'

// The `data-why` of an island in development, one line the dev tool shows.
export function causeSummary(cause: IslandCause, promoted: boolean): string {
  return promoted ? `static unless it passes an island what only an island sends: ${describeCause(cause)}` : describeCause(cause)
}
