import type { MailReply } from './mime'
import type { MailWaitOptions } from './outbox'
import type { MailAttachment } from './types'

/** @deprecated Renamed `MailAttachment` in 1.90, as kayjs-ai has an `Attachment` of its own; the old name works until 1.93. */
export type Attachment = MailAttachment

/** @deprecated Renamed `MailReply` in 1.90, as kayjs-ai has a `Reply` of its own; the old name works until 1.93. */
export type Reply = MailReply

/** @deprecated Renamed `MailWaitOptions` in 1.90, as `kay/test` has a `WaitOptions` of its own; the old name works until 1.93. */
export type WaitOptions = MailWaitOptions
