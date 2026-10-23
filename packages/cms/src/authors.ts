import type { Identity } from './files'

// Who the API's guard found behind a request, for the save it then answers to commit as.
export const authors = new WeakMap<Request, Identity>()

// Where the guard found a newsletter test send should go for a request: the `testTo` of its collection, else the signed-in person's email.
export const testAddresses = new WeakMap<Request, string>()
