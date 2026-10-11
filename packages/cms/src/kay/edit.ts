import type { DraftEntry, DraftResult } from './contract'

// Browser half of kaynooo/kayjs#262, to come from kay: renders the current page with these unsaved entries and swaps it in.
export async function showDraft(_entries: DraftEntry[]): Promise<DraftResult> {
  throw new Error('kay does not ship showDraft() yet (kaynooo/kayjs#262)')
}
