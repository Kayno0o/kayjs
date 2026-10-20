import type { GuardContext } from 'kay'
import { log } from './log'
import { settings } from './settings'

// A room and its member are at most 256 characters together as JSON, which a long slug or name must not break the screen over.
const MAX_KEY = 256
const MAX_NAME = 60
const MAX_ROOM = 100

export interface EntryPresence {
  room: string
  member: { name: string }
}

// The room editors of one entry share, and who the visitor is listed as in it: the name `cms({ author })` gives, none when the app names no author, so its editors are only counted.
export async function entryPresence(ctx: GuardContext, collection: string, entry: { slug: string, locale?: string | undefined }): Promise<EntryPresence> {
  let name = ''

  try {
    name = (await settings().author?.(ctx))?.name.slice(0, MAX_NAME) ?? ''
  }
  catch (error) {
    log.error('author threw, so the entry screen lists its editor with no name', error)
  }

  const full = `cms:${collection}:${entry.slug}${entry.locale === undefined ? '' : `@${entry.locale}`}`
  let room = full
  const fits = () => JSON.stringify([room, { name }]).length <= MAX_KEY

  // The room is cut before the name, as many times as its characters take escapes in JSON, and tells apart two slugs that only differ past the cut by a hash of the whole.
  for (let kept = MAX_ROOM; !fits() && kept >= 0; kept -= 10)
    room = `${full.slice(0, kept)}~${Bun.hash(full).toString(36)}`

  while (!fits() && name !== '')
    name = name.slice(0, -1)

  return { room, member: { name } }
}
