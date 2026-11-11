import { showDraft } from 'kay/edit'
import { browserKeeper, editorOfBrowser, sweepEvery } from '../draft-storage'
import { cmsDrafts } from '../drafts'

// The page's one set of drafts, shared by every form of the editor, kept in the browser so a reload brings the edits back.
const keeper = browserKeeper(undefined, undefined, editorOfBrowser)

export const drafts = cmsDrafts({ show: showDraft, keep: keeper })

if (typeof window !== 'undefined') {
  // Typing is kept after a pause, so what was typed in the last moments is kept as the page goes.
  window.addEventListener('pagehide', () => drafts.flush())
  // The drafts past their week are dropped as the editor opens and every hour it stays open, not only when one is read.
  const stop = sweepEvery(keeper, 3_600_000)

  import.meta.hot?.dispose(stop)
}
