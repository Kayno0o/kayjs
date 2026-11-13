import type { Span } from './ast'

// What makes a component an island: where it sits in the file and what it is, for the editor, `kay build`, `kay explain island` and the dev tool to say the same thing.
export type IslandCauseKind = 'client' | 'island' | 'attribute' | 'value' | 'live'

export interface IslandCause {
  kind: IslandCauseKind
  // The attribute (`onClick`, `bind:value`, `ref`), the `kay` value (`signal`) or the live value; `--- client` or `--- island` for the fence.
  name: string
  // Where it is in the file, which the editor reveals.
  span: Span
  // The 1-based line of the span.
  line: number
  // The `kay` value's module, as `kay`.
  source?: string | undefined
  // The props the component's `island` export says make a use interactive, each with whether it is on when left out: a use turning none on renders no island.
  interactive?: Readonly<Record<string, boolean>> | undefined
}

// The sentence of `kay build`, the lints and the lens.
export function describeCause(cause: IslandCause): string {
  return cause.interactive === undefined ? causeText(cause) : `${causeText(cause)}; a use that turns on none of ${staticUse(cause.interactive)} renders as markup with no script`
}

// The props a component lists, those on by default as the value that turns them off; a long list is counted, `kay explain island` printing it whole.
function staticUse(interactive: Readonly<Record<string, boolean>>): string {
  const names = Object.entries(interactive).map(([name, on]) => on ? `\`${name}\` (on unless \`false\`)` : `\`${name}\``)

  return names.length > 4 ? `its ${names.length} interactive props` : names.join(', ')
}

function causeText(cause: IslandCause): string {
  switch (cause.kind) {
    case 'client':
      return 'a `--- client` fence'
    case 'island':
      return 'a `--- island` fence'
    case 'attribute':
      return `\`${cause.name}\`, line ${cause.line}`
    case 'value':
      return `\`${cause.name}\` from ${cause.source}`
    case 'live':
      return `\`${cause.name}\`, a live value`
  }
}

// What the cause is, in a few words.
export const CAUSE_KINDS: Record<IslandCauseKind, string> = {
  client: 'a `--- client` fence: the component renders in the browser only',
  island: 'a `--- island` fence: the author pinned the component as an island',
  attribute: 'an `on*`, `bind:` or `ref` attribute: the browser handles it',
  value: 'a `kay` value of the browser, such as `signal` or `effect`, that its script uses',
  live: 'a live value its script imports: the browser follows it',
}

// The rule, as `kay explain island` says it.
export const ISLAND_RULE = 'A component is an island when it needs the browser: an `on*`, `bind:` or `ref` in its template, a browser value of `kay` in its script, a live value it imports, or a `--- client` or `--- island` fence; what an island renders is part of it. A static component that passes an island a function or a block taking parameters is an `island-prop` error, and is made an island by `--- island`. A component whose `export const island` lists `interactive` props is an island only in a use that turns one on: any other use renders as markup with no script.'
