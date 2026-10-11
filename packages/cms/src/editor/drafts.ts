import { showDraft } from 'kay/edit'
import { createDrafts } from '../drafts'

// The page's one set of drafts, shared by every form of the editor.
export const drafts = createDrafts({ show: showDraft })
