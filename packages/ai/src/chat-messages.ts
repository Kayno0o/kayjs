import type { ChatMessage } from './types'
import { s } from 'kay'

export interface ChatMessagesOptions {
  // The most messages a send holds, 40: `Chat` posts its `keep` (20 by default) at most, and a longer history is refused with a 422.
  maxItems?: number | undefined
  // The most characters of a message's text, 4,000.
  maxLength?: number | undefined
  // Lets a message carry the files `Chat`'s `attach` posts as `attachments`, of the given types (images and PDFs by default) and at most `maxFiles` of them (4); the action then takes a `maxSize` of its own for the files.
  attachments?: boolean | { type?: string | string[] | undefined, maxFiles?: number | undefined } | undefined
}

const DEFAULT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']

const message = (maxLength: number) => ({ role: s.UnionEnum(['user', 'assistant']), content: s.String({ maxLength }) })

const withFiles = (maxLength: number, { type = DEFAULT_TYPES, maxFiles = 4 }: { type?: string | string[] | undefined, maxFiles?: number | undefined }) => s.Object({ ...message(maxLength), attachments: s.Optional(s.Array(s.File({ type }), { maxItems: maxFiles })) })

const plain = (maxLength: number, maxItems: number) => s.Array(s.Object(message(maxLength)), { minItems: 1, maxItems })
const filed = (maxLength: number, maxItems: number, files: { type?: string | string[] | undefined, maxFiles?: number | undefined }) => s.Array(withFiles(maxLength, files), { minItems: 1, maxItems })

type WithoutFiles = ChatMessagesOptions & { attachments?: false | undefined }

// The schema of the history a `Chat` posts to its action, for `s.Object({ messages: chatMessages() })`: at least one message, each with a role and a text, and the files when `attachments` is set.
export function chatMessages(options?: WithoutFiles): ReturnType<typeof plain>
export function chatMessages(options: ChatMessagesOptions): ReturnType<typeof filed>
export function chatMessages(options: ChatMessagesOptions = {}) {
  const { maxItems = 40, maxLength = 4000, attachments = false } = options

  return attachments === false ? plain(maxLength, maxItems) : filed(maxLength, maxItems, typeof attachments === 'object' ? attachments : {})
}

// The message the visitor just sent, for an action that keeps the conversation itself and reads only that one: the last of a history `chatMessages()` accepted, which always holds one.
export function lastChatMessage<Messages extends readonly ChatMessage[]>(messages: Messages): Messages[number] {
  return messages.at(-1)!
}
