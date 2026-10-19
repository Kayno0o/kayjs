import { provideContext, readContext } from './reactive'

// What a component hands the first field it renders, read by the server's markup.
// Marked pure so the entry drops it when no island describes a field.
const DESCRIBED = /* @__PURE__ */ Symbol('kay.described')

interface Description {
  ids: string
  taken: boolean
  required: boolean | 'all'
  requiredTaken: boolean
}

export interface DescribeOptions {
  // Marks the field `aria-required="true"` as well: the first field, or every field with `'all'`, such as a group of checkboxes.
  required?: boolean | 'all' | undefined
}

// Adds `ids` to the `aria-describedby` of the first input, select or textarea the calling component renders on the server, its slot included, beside the field's own ids.
// A component such as a form field links its control to its hint and messages this way, the control being its parent's markup; in an island the browser keeps that link itself.
// `required` gives the field `aria-required="true"` unless the field sets its own.
export function describeField(ids: string, options: DescribeOptions = {}): void {
  const required = options.required ?? false

  provideContext(DESCRIBED, { ids, taken: ids === '', required, requiredTaken: required === false } satisfies Description)
}

// The field's own description with the ids the nearest `describeField` above hands the field rendering now, once: the first field takes them.
export function fieldDescription(own?: unknown): unknown {
  const found = readContext(DESCRIBED).value as Description | undefined

  if (!found || found.taken)
    return own

  found.taken = true

  return typeof own === 'string' && own !== '' ? `${own} ${found.ids}` : found.ids
}

// Whether the field rendering now takes `aria-required` from the nearest `describeField` above: the first field, or each with `'all'`.
export function fieldRequired(): boolean {
  const found = readContext(DESCRIBED).value as Description | undefined

  if (!found || found.requiredTaken)
    return false

  if (found.required !== 'all')
    found.requiredTaken = true

  return true
}
