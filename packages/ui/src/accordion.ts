// One section of an Accordion. `key` is what `value`, `onChange` and the blocks carry.
// `open` starts a section unfolded; with one open at a time, the first one flagged wins. `disabled` keeps a section as it is, and `meta` draws a count or a state in its band, as CollapsibleSection's does.
export interface AccordionItem {
  key: string
  label: string
  open?: boolean | undefined
  disabled?: boolean | undefined
  meta?: string | undefined
}
