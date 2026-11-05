import type { CmsDraftEntry } from './kay/contract'
import type { CmsAction } from './roles'

/** @deprecated Renamed `CmsAction` in 1.90, as kay has an `Action` of its own; the old name works until 1.93. */
export type Action = CmsAction

/** @deprecated Renamed `CmsDraftEntry` in 1.90, as `kay/edit` has a `DraftEntry` of its own; the old name works until 1.93. */
export type DraftEntry = CmsDraftEntry
