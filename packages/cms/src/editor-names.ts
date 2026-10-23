import { editSessionOf } from 'kay/server'

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

// Whether the edit cookie of the request is one a guard of the app let through. A request with none is not told, whatever it replays: a proof is not tied to the cookie of the page that made it.
function mayReadNames(request: Request | undefined): boolean {
  const cookie = request === undefined ? undefined : editSessionOf(request)
  const seen = cookie === undefined ? undefined : admitted.get(cookie)

  return seen !== undefined && Date.now() - seen < KEPT_MS
}

// Whether the member was named by the screens: the guarded screens list an editor under the name `author` gave, or as a list watching, and the on-page editor under neither, so a page of an edit link's holder never proves such a member.
function listedByScreen(member: string): boolean {
  try {
    const listed = JSON.parse(member) as { name?: unknown, watching?: unknown } | null

    return (typeof listed?.name === 'string' && listed.name !== '') || listed?.watching === true
  }
  catch {
    return false
  }
}

// What a stream, or the render of a page, is sent of a room: the editors' names when the member joined from the guarded screens or the edit cookie was let through by the app's guard, else the members with none, which counts them.
export function viewMembers(request: Request | undefined, room: string, members: string[], member: string): string[] {
  if (!NAMED.test(room) || listedByScreen(member) || mayReadNames(request))
    return members

  return members.map((text) => {
    try {
      const listed = JSON.parse(text) as unknown

      return typeof listed === 'object' && listed !== null && 'name' in listed ? JSON.stringify({ ...listed, name: '' }) : text
    }
    catch {
      return text
    }
  })
}
