import type { Tone } from './tone'
import { wording } from 'kay/words'

// Apart from `confirm.ts`, so a ConfirmDelete island holds the words and none of the questions' queue.
// The words of a confirm by its tone, shared by `confirm` and `ConfirmDelete`: a `danger` one speaks of deleting, any other of confirming, `label` standing in for every word it does not name.
export function confirmWords<Title = string>(tone: Tone, given: { label?: string | undefined, title?: Title | undefined, confirmLabel?: string | undefined, pendingLabel?: string | undefined, cancelLabel?: string | undefined }) {
  const danger = tone === 'danger'
  const trigger = given.label ?? (danger ? wording('ui.confirmDelete.delete', 'Delete') : wording('ui.confirmDelete.confirm', 'Confirm'))
  const confirmText = given.confirmLabel ?? (danger ? wording('ui.confirmDelete.delete', 'Delete') : trigger)

  return {
    trigger,
    title: given.title ?? (danger ? wording('ui.confirmDelete.title', 'Confirm Deletion') : trigger),
    confirm: confirmText,
    pending: given.pendingLabel ?? (danger ? wording('ui.confirmDelete.pending', 'Deleting…') : confirmText),
    cancel: given.cancelLabel ?? wording('ui.confirmDelete.cancel', 'Cancel'),
    // The button colour: a neutral confirm is an accent one.
    look: (tone === 'neutral' ? 'accent' : tone) satisfies Tone,
  }
}
