import { queryParam } from 'kay'

// Shared by the islands of the page, as an app keeps the open dialog or a range.
export const shared = queryParam<string>('x', { default: 'none' })
