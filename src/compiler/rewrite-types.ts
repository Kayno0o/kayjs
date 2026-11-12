import type { Diagnostic, Span } from './ast'
import type { Rewrite, SourceMap } from './mapping'
import type { SignalKind } from './module-signals'
import type { WRITE_HELPERS } from './names'
import type { PropsBinding } from './script'

export type Rewrites = Map<number, Rewrite & { end: number }>

// Where the analysis pass declares the names whose reads the final pass rewrites, by generated offset.
export interface Sites {
  // Arrow parameters, and the index a loop declares in its block, that code which runs reads through a call: a loop's row and index, an `if`'s alias.
  rows: Set<number>
  // A template `const`'s pattern, true when code that runs reads its names as memos.
  consts: Map<number, boolean>
  // The `consts` among them that destructure a loop's item, which behave as the item of a plain loop does.
  loopItems: Set<number>
  // A template `snippet`'s name, a function read as it is written.
  snippets: Set<number>
  // Each name destructured off the props object, a prop or a server value, with its index among the props, which names its default.
  props: Map<number, { binding: PropsBinding, index: number }>
  // The `return` ending `load`, which hands the server fence's names to the template.
  handOver?: Span | undefined
}

export interface RewriteInput {
  // The analysis pass's code and where it came from.
  code: string
  map: SourceMap
  sites: Sites
  // Code only read by the type checker, where a row, an alias or a signal the template reads is its value rather than an accessor to it, so TypeScript narrows it; its assignments are still reported.
  values: boolean
  // The browser code is being made, where a component tag that can hold text opens as `KayDynamic`.
  dom?: boolean | undefined
  // Where the template begins in the source, past which a signal's name reads its value.
  templateStart: number
  // The signals and memos the component imports from its own modules, by local name.
  imported?: ReadonlyMap<string, SignalKind> | undefined
  // The name the file gives the component, which a template `const` would hide from the tags after it.
  component?: string | undefined
  // A page with a server fence, a layout or a special page, which renders once on the server and is no island, so a live value read in its template would not follow the server.
  fixedPage?: boolean | undefined
  // Type checking a project: a write to a name kay sees no signal made in asserts it holds one, through `KayWritable`.
  check?: boolean | undefined
}

// What the final pass applies.
interface RewritePlan {
  rewrites: Rewrites
  // Type checking: the value of each signal the template reads, which `VALUES` holds.
  values: Map<string, string>
  // The write helpers the rewrites call, which the module imports from the runtime.
  writes: Set<keyof typeof WRITE_HELPERS>
}

export interface ConstantSignal {
  name: Span
  value?: Span | undefined
}

// What the analysis pass learns of the component's names, besides how to rewrite them.
export interface NameFindings {
  // Where the bindings nothing in the component reads are declared, by source offset.
  unread: Set<number>
  // The server data the fence itself reads, besides handing it to the template.
  serverReads: Set<string>
  // Where the signals nothing writes are declared, and the value they start with: every use of one reads it.
  constantSignals: ConstantSignal[]
  // The names read as values that nothing in the module declares, which the component function must not take.
  globalReads: Set<string>
}

export interface FoundRewrites {
  plan: RewritePlan
  findings: NameFindings
  diagnostics: Diagnostic[]
  // Set when the generated code does not parse, which means the template or script holds code that is not valid; no rewrite was found.
  syntaxError?: Diagnostic
}
