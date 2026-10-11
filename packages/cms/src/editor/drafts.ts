import { createDrafts } from '../drafts'
import { showDraft } from '../kay/edit'

// The page's one set of drafts, shared by every form of the editor.
export const drafts = createDrafts({ show: showDraft })
