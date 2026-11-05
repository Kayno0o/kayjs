import type { AiAttachment, AiMessage, AiReply, AiToolCall } from './types'

/** @deprecated Renamed `AiAttachment` in 1.90, as kayjs-mail has an `Attachment` of its own; the old name works until 1.93. */
export type Attachment = AiAttachment

/** @deprecated Renamed `AiMessage` in 1.90, as kay has a `Message` of its own; the old name works until 1.93. */
export type Message = AiMessage

/** @deprecated Renamed `AiReply` in 1.90, as kayjs-mail has a `Reply` of its own; the old name works until 1.93. */
export type Reply = AiReply

/** @deprecated Renamed `AiToolCall` in 1.90, as kay's MCP log has a `ToolCall` of its own; the old name works until 1.93. */
export type ToolCall = AiToolCall
