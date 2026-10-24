import type { Identity } from './files'

// Who the API's guard found behind a request, for the save it then answers to commit as.
export const authors = new WeakMap<Request, Identity>()

// Where the guard found a newsletter test send should go for a request: the `testTo` of its collection, else the signed-in person's email.
export const testAddresses = new WeakMap<Request, string>()

// Who the API's guard found behind a review request: the name and the kayjs-auth id of the person, and whom a submission is told to (the other holders of a reviewing organization role).
export interface Actor {
  name: string
  id?: string | undefined
  reviewers: string[]
}

export const actors = new WeakMap<Request, Actor>()

// The requests an edit link's holder made: read through the edit cookie alone, the app's guard having turned them away.
export const linkReaders = new WeakSet<Request>()
