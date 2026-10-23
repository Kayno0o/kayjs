import { editRequested, editSessionOf } from 'kay/server'

// How many edit cookies are kept as a guard's admitted ones, the oldest going first, and how long one is kept: an edit cookie's own life is shorter or as long.
const MAX_ADMITTED = 2000
const KEPT_MS = 24 * 60 * 60 * 1000

// The edit cookies a guard of the app let through, each against when it was last seen: an edit link's cookie is tied to no person, so this is what tells the person the app signed in from the holder of a link.
const admitted = new Map<string, number>()

// The rooms that list editors by name: the entry's own and the one a list watches it through.
const NAMED = /^(?:watch:)?cms:/

// Marks the edit cookie the app's guard let in, which then reads editor names: the request's own, or the one just given to it. A request with neither has nothing to mark.
export function admitEditor(request: Request, given?: string): void {
  const cookie = given ?? editSessionOf(request)

  if (cookie === undefined)
    return

  const now = Date.now()

  admitted.delete(cookie)

  for (const [key, seen] of admitted) {
    if (now - seen < KEPT_MS && admitted.size < MAX_ADMITTED)
      break

    admitted.delete(key)
  }

  admitted.set(cookie, now)
}

function mayReadNames(request: Request): boolean {
  if (!editRequested(request))
    return true

  const cookie = editSessionOf(request)
  const seen = cookie === undefined ? undefined : admitted.get(cookie)

  return seen !== undefined && Date.now() - seen < KEPT_MS
}

// What a stream is sent of a room: the editors' names only when the app's guard let its request in, else the members with none, which counts them. A request in edit mode that no guard let in is an edit link's holder, whatever room its page named.
export function viewMembers(request: Request, room: string, members: string[]): string[] {
  if (!NAMED.test(room) || mayReadNames(request))
    return members

  return members.map((text) => {
    try {
      const member = JSON.parse(text) as unknown

      return typeof member === 'object' && member !== null && 'name' in member ? JSON.stringify({ ...member, name: '' }) : text
    }
    catch {
      return text
    }
  })
}
