import { showDraft } from 'kay/edit'
import { browserKeeper, editorOfBrowser } from '../draft-storage'
import { cmsDrafts } from '../drafts'

// The page's one set of drafts, shared by every form of the editor, kept in the browser so a reload brings the edits back.
export const drafts = cmsDrafts({ show: showDraft, keep: browserKeeper(undefined, undefined, editorOfBrowser) })

// Typing is kept after a pause, so what was typed in the last moments is kept as the page goes.
if (typeof window !== 'undefined')
  window.addEventListener('pagehide', () => drafts.flush())
