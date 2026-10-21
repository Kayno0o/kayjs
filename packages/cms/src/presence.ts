import type { GuardContext } from 'kay'
import type { Member } from './room'
import { log } from './log'
import { entryRoom } from './room'
import { settings } from './settings'

const MAX_NAME = 60

export interface EntryPresence {
  room: string
  member: Member
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

  return entryRoom(collection, entry, { name })
}
