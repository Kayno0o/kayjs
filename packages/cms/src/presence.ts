import type { GuardContext } from 'kay'
import { log } from './log'
import { settings } from './settings'

// A room and its member are at most 256 characters together as JSON, which a long slug or name must not break the screen over.
const MAX_KEY = 256
const MAX_NAME = 60

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

  let room = `cms:${collection}:${entry.slug}${entry.locale === undefined ? '' : `@${entry.locale}`}`
  const fits = () => JSON.stringify([room, { name }]).length <= MAX_KEY

  while (!fits() && name !== '')
    name = name.slice(0, -1)

  if (!fits())
    room = `${room.slice(0, 100)}~${Bun.hash(room).toString(36)}`

  return { room, member: { name } }
}
