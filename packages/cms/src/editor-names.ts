import { admitEditSession, editSessionAdmitted } from 'kay/library'

// The rooms that list editors by name: the entry's own and the one a list watches it through.
const NAMED = /^(?:watch:)?cms:/

// Marks the edit cookie the app's guard let in, which then reads editor names in any process and after a restart: the request's own, or the one just given to it. A request with neither has nothing to mark.
export function admitEditor(ctx: { cookies: Bun.CookieMap, request: Request }, given?: string): void {
  admitEditSession(ctx, given)
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

// What a stream, or the render of a page, is sent of a room: the editors' names when the member joined from the guarded screens or the edit cookie was let through by the app's guard, else the members with none, which counts them. Every member stays in the list, so the count is the same either way.
// A request with no edit cookie is not told, whatever it replays: a proof is not tied to the cookie of the page that made it.
export function viewMembers(request: Request | undefined, room: string, members: string[], member: string): string[] {
  if (!NAMED.test(room) || listedByScreen(member) || (request !== undefined && editSessionAdmitted(request)))
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
