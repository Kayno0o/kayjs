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
  // Marks the field `required` and `aria-required="true"` as well: the first field, or every field with `'all'`, such as a group of checkboxes, which take `aria-required` alone as the browser would ask for every box.
  required?: boolean | 'all' | undefined
}

// Adds `ids` to the `aria-describedby` of the first input, select or textarea the calling component renders on the server, its slot included, beside the field's own ids.
// A component such as a form field links its control to its hint and messages this way, the control being its parent's markup; in an island the browser keeps that link itself.
// `required` gives the field the native `required`, so the browser and a post with no JavaScript know it, and `aria-required="true"` where its type takes one, unless the field sets its own.
// kept: free
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

// How the field rendering now is required by the nearest `describeField` above: `'first'` for the first field, `'all'` for each with `'all'`, false for the others.
export function fieldRequired(): false | 'first' | 'all' {
  const found = readContext(DESCRIBED).value as Description | undefined

  if (!found || found.requiredTaken)
    return false

  if (found.required !== 'all') {
    found.requiredTaken = true

    return 'first'
  }

  return 'all'
}
