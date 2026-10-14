import type { Identity } from './files'

// Who the API's guard found behind a request, for the save it then answers to commit as.
export const authors = new WeakMap<Request, Identity>()
