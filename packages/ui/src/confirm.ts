import type { Tone } from './tone'
import { signal } from 'kay'
import { wording } from 'kay/words'
import { claimed } from './claim'

export interface ConfirmOptions {
  // The question.
  message: string
  // The dialog's title: `Confirm` by default, `Confirm Deletion` for a `danger` tone.
  title?: string | undefined
  // `neutral` (the default) draws accent buttons; `danger` is the delete preset, with the delete words and a danger confirm button. Any other `Tone` colours the confirm button.
  tone?: Tone | undefined
  // The confirm button's text: `Confirm` by default, `Delete` for a `danger` tone.
  confirmLabel?: string | undefined
  cancelLabel?: string | undefined
}

export interface Asked extends ConfirmOptions {
  id: number
  settle: (answer: boolean) => void
}

let nextId = 1

// The questions `ConfirmHost` asks one after the other. Only ever added to in the browser: the server's copy of this module is shared by every request, so it stays empty.
export const questions = signal<Asked[]>([])

// Asks the reader and resolves `true` once they confirm, `false` when they cancel, press Escape or click outside. Questions asked together are shown one after the other. Mounted by `ui()` for every page, or by a `ConfirmHost` the app renders itself; with neither on the page the browser's own `confirm` asks. On the server, where nobody can answer, it answers `false`.
export async function confirm(options: ConfirmOptions | string): Promise<boolean> {
  const asked = typeof options === 'string' ? { message: options } : options

  if (typeof document === 'undefined')
    return false

  // The last resort, so a page with no host still asks.
  if (!claimed('confirms'))
    // eslint-disable-next-line no-alert
    return window.confirm(asked.message)

  return new Promise((resolve) => {
    const id = nextId++

    questions.set(list => [...list, { ...asked, id, settle: resolve }])
  })
}

// Resolves the question and takes it off the list.
export function answer(question: Asked, answered: boolean): void {
  questions.set(list => list.filter(item => item.id !== question.id))
  question.settle(answered)
}

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

// What a Dialog or SidePanel asks before dropping typed text: the app words it, or turns it off with `false` to keep the close locked.
export type Discard = Pick<ConfirmOptions, 'title' | 'message' | 'confirmLabel' | 'cancelLabel'> | false

// Asks whether to drop what was typed, `danger` as the loss is.
export async function confirmDiscard(given: Exclude<Discard, false> | undefined): Promise<boolean> {
  return confirm({
    tone: 'danger',
    title: given?.title ?? wording('ui.confirm.discardTitle', 'Discard changes?'),
    message: given?.message ?? wording('ui.confirm.discardMessage', 'What you typed has not been saved.'),
    confirmLabel: given?.confirmLabel ?? wording('ui.confirm.discard', 'Discard'),
    cancelLabel: given?.cancelLabel ?? wording('ui.confirm.keep', 'Keep editing'),
  })
}
