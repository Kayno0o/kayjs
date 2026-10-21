// What the editors of one entry share, on the screens and on the page: the room, and who is listed in it. Pure, so the on-page editor reads it where `presence.ts`, which asks the app's `author`, cannot go.

// A room and its member are at most 256 characters together as JSON, which a long slug or name must not break the screen over.
const MAX_KEY = 256
const MAX_ROOM = 100
// What the room name leaves to the member, so the same entry has the same room whoever is listed in it.
const MEMBER_ROOM = 80

// The most rows of a list that watch their entry, as every watched room is a key the page's live proof and watch carry.
export const WATCHED_ROWS = 50

// An editor, by the name `cms({ author })` gives. `watching` marks a list showing the entry, which is no editor of it.
export interface Member {
  name: string
  watching?: true | undefined
}

// The room a list watches an entry through: every editor of the entry is also listed in it, and the lists in it are known to no editor, so the editors' own room counts only editors.
export function watchRoom(room: string): string {
  return `watch:${room}`
}

// A hash of the whole text in plain JavaScript, as the room is also named in the browser, where there is no `Bun`: two 32-bit FNV-1a runs, the second seeded apart.
export function hashOf(text: string): string {
  let first = 0x811C9DC5
  let second = 0x01000193

  for (let at = 0; at < text.length; at++) {
    first = Math.imul(first ^ text.charCodeAt(at), 0x01000193) >>> 0
    second = Math.imul(second ^ text.charCodeAt(at), 0x811C9DC5) >>> 0
  }

  return first.toString(36) + second.toString(36)
}

export function entryRoom(collection: string, entry: { slug: string, locale?: string | undefined }, listed: Member): { room: string, member: Member } {
  const full = `cms:${collection}:${entry.slug}${entry.locale === undefined ? '' : `@${entry.locale}`}`
  const member = { ...listed }
  let room = full
  const fits = () => JSON.stringify(watchRoom(room)).length <= MAX_KEY - MEMBER_ROOM

  // The room is cut as many times as its characters take escapes in JSON, and tells apart two slugs that only differ past the cut by a hash of the whole.
  for (let kept = MAX_ROOM; !fits() && kept >= 0; kept -= 10)
    room = `${full.slice(0, kept)}~${hashOf(full)}`

  while (JSON.stringify([watchRoom(room), member]).length > MAX_KEY && member.name !== '')
    member.name = member.name.slice(0, -1)

  return { room, member }
}

// Who `others` and `count` of a presence() say has the entry open, besides the member `own`: their names, or how many are there with none. A list watching through `watchRoom` is `own.watching`, and learns only that someone edits.
export function editorsOf(others: readonly Member[], count: number, own: Member): { names: string[], unnamed: number } {
  const names = others.map(member => member.name).filter(name => name !== '')

  if (names.length > 0)
    return { names, unnamed: 0 }

  // An editor with no name counts the tabs, the editor's own other tabs included, while a named one is told that an editor with none is there.
  if (own.watching !== true && own.name === '')
    return { names: [], unnamed: count }

  return { names: [], unnamed: others.length > 0 ? 1 : 0 }
}
