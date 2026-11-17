// Marks a feature of a component that an app may leave out: true while the prop is there to be written. A browser build replaces each call with `true` or `false` once it has read the props the importing file writes at its call sites, and what the false branches held falls out of the island (src/build/variants.ts); everywhere else the call answers true.
// `uses('sortable', true)` names a feature that is on when the prop is left out: it is false only where every call site writes the prop as a literal `false`.
export function uses(_feature: string, _onByDefault?: boolean): boolean {
  return true
}
