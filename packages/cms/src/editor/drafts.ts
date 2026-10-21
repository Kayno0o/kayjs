import { signal } from 'kay'
import { showDraft } from 'kay/edit'
import { browserKeeper } from '../draft-storage'
import { createDrafts } from '../drafts'
import { browserStorage } from './dock'
import { markRebuilding, rebuildingFor } from './rebuild'

// The page's one set of drafts, shared by every form of the editor, kept in the browser so a reload brings the edits back.
export const drafts = createDrafts({ show: showDraft, keep: browserKeeper() })

const waiting = signal(false)
let expiry: ReturnType<typeof setTimeout> | undefined

// Whether a save the site shows only once it has rebuilt went through lately, read again from the browser's storage.
export const rebuilding = () => waiting()

export function watchRebuild(): void {
  const left = rebuildingFor(browserStorage())

  clearTimeout(expiry)
  waiting.set(left > 0)

  if (left > 0)
    expiry = setTimeout(() => waiting.set(false), left)
}

export function rebuildStarted(): void {
  markRebuilding(browserStorage())
  watchRebuild()
}
