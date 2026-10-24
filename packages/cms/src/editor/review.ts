import type { Signal } from 'kay'
import type { Drafts } from '../drafts'
import type { EntryRef } from '../kay/contract'
import type { ReviewView } from '../review'
import type { ReviewReply } from './save'
import { signal } from 'kay'
import { approveSaved, refuseUnsaved, sendBackSaved, submitSaved } from './save'

export interface EntryReview {
  review: Signal<ReviewView | undefined>
  busy: Signal<boolean>
  submit: () => Promise<boolean>
  approve: () => Promise<boolean>
  sendBack: (note: string) => Promise<boolean>
}

// The review of a saved entry in a form: each step acts on the entry as saved, so it refuses while edits are not, and takes what the server answers, an approval's publication included, as the entry's saved state.
export function createReview(ref: EntryRef, initial: ReviewView | undefined, drafts: Drafts): EntryReview {
  const review = signal(initial)
  const busy = signal(false)

  async function step(run: () => Promise<ReviewReply | undefined>): Promise<boolean> {
    if (busy() || drafts.changed(ref))
      return drafts.changed(ref) ? (refuseUnsaved(), false) : false

    busy.set(true)

    try {
      const reply = await run()

      if (!reply)
        return false

      review.set(reply.review)

      if (reply.entry?.data !== undefined)
        drafts.adopt(ref, { ...ref, data: reply.entry.data, body: reply.entry.body }, reply.entry.version)

      return true
    }
    finally {
      busy.set(false)
    }
  }

  return {
    review,
    busy,
    submit: async () => step(async () => submitSaved(ref)),
    approve: async () => step(async () => approveSaved(ref, drafts.version(ref))),
    sendBack: async note => step(async () => sendBackSaved(ref, note)),
  }
}
