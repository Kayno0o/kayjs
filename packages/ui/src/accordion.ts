// `open` starts a section unfolded; with one open at a time, the first one flagged wins. `disabled` keeps a section as it is, and `meta` draws a count or a state in its band, as CollapsibleSection's does.
interface AccordionItemBase {
  open?: boolean | undefined
  disabled?: boolean | undefined
  meta?: string | undefined
}

type Keyed = { key: string, /** @deprecated Use `key`, which wins when both are given. Removed in 1.103, `deprecated-ui-items` finds it. */ value?: string | undefined } | { key?: undefined, /** @deprecated Use `key`, which wins when both are given. Removed in 1.103, `deprecated-ui-items` finds it. */ value: string }
type Labelled = { label: string, /** @deprecated Use `label`, which wins when both are given. Removed in 1.103, `deprecated-ui-items` finds it. */ title?: string | undefined } | { label?: undefined, /** @deprecated Use `label`, which wins when both are given. Removed in 1.103, `deprecated-ui-items` finds it. */ title: string }

// One section of an Accordion. `key` is what `value`, `onChange` and the blocks carry; `value` and `title` are the names `key` and `label` had before 1.99.
export type AccordionItem = AccordionItemBase & Keyed & Labelled

export function itemKey(item: AccordionItem): string {
  return item.key ?? item.value
}

export function itemLabel(item: AccordionItem): string {
  return item.label ?? item.title
}
