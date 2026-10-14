import { provideContext, readContext } from './reactive'

// What a component hands the first field it renders, read by the server's markup.
const DESCRIBED = Symbol('kay.described')

interface Description {
  ids: string
  taken: boolean
}

// Adds `ids` to the `aria-describedby` of the first input, select or textarea the calling component renders on the server, its slot included, beside the field's own ids.
// A component such as a form field links its control to its hint and messages this way, the control being its parent's markup; in an island the browser keeps that link itself.
export function describeField(ids: string): void {
  provideContext(DESCRIBED, { ids, taken: ids === '' } satisfies Description)
}

// The field's own description with the ids the nearest `describeField` above hands the field rendering now, once: the first field takes them.
export function fieldDescription(own?: unknown): unknown {
  const found = readContext(DESCRIBED).value as Description | undefined

  if (!found || found.taken)
    return own

  found.taken = true

  return typeof own === 'string' && own !== '' ? `${own} ${found.ids}` : found.ids
}
