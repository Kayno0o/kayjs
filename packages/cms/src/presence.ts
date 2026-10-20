import type { GuardContext } from 'kay'
import { settings } from './settings'

// The room and member of the keys `presence()` takes are at most 256 characters together as JSON, which a long slug or name must not break the screen over.
const MAX_ROOM = 150
const MAX_NAME = 60

export interface EntryPresence {
  room: string
  member: { name: string }
}

// The room editors of one entry share, and who the visitor is listed as in it: the name `cms({ author })` gives, none when the app names no author, so its editors are only counted.
export async function entryPresence(ctx: GuardContext, collection: string, entry: { slug: string, locale?: string | undefined }): Promise<EntryPresence> {
  const identity = await settings().author?.(ctx)
  const room = `cms:${collection}:${entry.slug}${entry.locale === undefined ? '' : `@${entry.locale}`}`

  return {
    room: room.length > MAX_ROOM ? `${room.slice(0, MAX_ROOM - 14)}~${Bun.hash(room).toString(36)}` : room,
    member: { name: identity?.name.slice(0, MAX_NAME) ?? '' },
  }
}
