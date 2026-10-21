import { wording } from 'kay/words'

// The most referencing entries a delete confirmation names; the rest is told as a trailing ellipsis.
const REFERRERS_SHOWN = 5

// Which entries name the one deleted, as a confirmation tells it.
export function referrersNote(referencedBy: string[]): string {
  const entries = referencedBy.slice(0, REFERRERS_SHOWN).join(', ') + (referencedBy.length > REFERRERS_SHOWN ? ', …' : '')

  return wording('cms.entry.deleteReferenced', 'Referenced by {entries}.', { entries })
}

// What a delete of the ticked rows asks: how many, and which other entries name any of them.
export function bulkDeleteMessage(count: number, referencedBy: string[] = []): string {
  const asked = wording('cms.bulk.deleteMessage', count === 1 ? 'Delete 1 entry? This cannot be undone.' : 'Delete {count} entries? This cannot be undone.', { count })

  return referencedBy.length === 0 ? asked : `${asked} ${referrersNote(referencedBy)}`
}
