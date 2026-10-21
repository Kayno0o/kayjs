import { showDraft } from 'kay/edit'
import { browserKeeper } from '../draft-storage'
import { createDrafts } from '../drafts'

// The page's one set of drafts, shared by every form of the editor, kept in the browser so a reload brings the edits back.
export const drafts = createDrafts({ show: showDraft, keep: browserKeeper() })
