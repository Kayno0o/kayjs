// What the editors of one entry share, on the screens and on the page: the room, and who is listed in it. Pure, so the on-page editor reads it where `presence.ts`, which asks the app's `author`, cannot go.

// A room and its member are at most 256 characters together as JSON, which a long slug or name must not break the screen over.
const MAX_KEY = 256
const MAX_ROOM = 100

// An editor, by the name `cms({ author })` gives. `watching` marks a list showing the entry, which is no editor of it.
export interface Member {
  name: string
  watching?: true | undefined
}

// A hash of the whole text in plain JavaScript, as the room is also named in the browser, where there is no `Bun`: two 32-bit FNV-1a runs, the second seeded apart.
function hashOf(text: string): string {
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
  const fits = () => JSON.stringify([room, member]).length <= MAX_KEY

  // The room is cut before the name, as many times as its characters take escapes in JSON, and tells apart two slugs that only differ past the cut by a hash of the whole.
  for (let kept = MAX_ROOM; !fits() && kept >= 0; kept -= 10)
    room = `${full.slice(0, kept)}~${hashOf(full)}`

  while (!fits() && member.name !== '')
    member.name = member.name.slice(0, -1)

  return { room, member }
}

// Who `others` and `count` of a presence() say has the entry open, besides the member `own`: their names, or how many are there with none. A tab that only watches the list is no editor, and is counted by no one.
export function editorsOf(others: readonly Member[], count: number, own: Member): { names: string[], unnamed: number } {
  const editors = others.filter(member => member.watching !== true)
  const names = editors.map(member => member.name).filter(name => name !== '')

  if (names.length > 0)
    return { names, unnamed: 0 }

  const present = editors.length > 0 ? 1 : 0

  // The list only learns that someone edits, and a named editor that an unnamed one does.
  if (own.watching === true || own.name !== '')
    return { names: [], unnamed: present }

  // An editor with no name counts the tabs, the editor's own other tabs included, unless a list's tabs are among them, which cannot be told apart.
  return { names: [], unnamed: others.length > editors.length ? present : count }
}
