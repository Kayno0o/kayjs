// The utilities a Checkbox and a FormField draw with, which ContactForm's hand-built consent and messages and kayjs-cms's field inputs take from here so a restyle of one reaches the copies.
export const CHECKBOX = {
  root: 'kui-checkbox inline-flex cursor-pointer items-center gap-2 has-[input:disabled]:opacity-50 has-[input[aria-busy=true]]:cursor-progress has-[input:disabled:not([aria-busy=true])]:cursor-not-allowed',
  input: 'm-0 size-4 shrink-0 cursor-[inherit] accent-kui-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kui-accent',
  label: 'text-sm text-kui-text',
  hint: 'text-xs text-kui-subtext0',
}

export const FIELD_MESSAGE = {
  hint: 'text-xs text-kui-subtext0',
  issues: 'flex flex-col',
  issue: 'text-xs text-kui-error',
}
