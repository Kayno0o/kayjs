// The header a Chat with `remember` sends with each call so a reply that outlives the page can be found again: `start:<id>` names the reply being asked, `resume:<id>` asks for it again after a reload, `stop:<id>` ends it.
export const REPLY_HEADER = 'x-kai-reply'

const OPERATIONS = new Set(['start', 'resume', 'stop'])
const ID = /^[\w-]{8,64}$/

export interface ReplyCall {
  op: 'start' | 'resume' | 'stop'
  // Undefined when the header named no usable id: such a resume or stop finds nothing, and a start is no start.
  id: string | undefined
}

// What the request being answered says of the reply it asks for, or nothing for an ordinary call.
export function replyCallOf(request: Request | undefined): ReplyCall | undefined {
  const header = request?.headers.get(REPLY_HEADER)

  if (header === null || header === undefined || header === '')
    return undefined

  const colon = header.indexOf(':')
  const op = colon === -1 ? header : header.slice(0, colon)
  const id = colon === -1 ? '' : header.slice(colon + 1)

  return !OPERATIONS.has(op) ? undefined : { op: op as ReplyCall['op'], id: ID.test(id) ? id : undefined }
}

// The header a Chat sends when its post replaces turns of the conversation: `regenerate:<n>` or `edit:<n>`, `n` the trailing turns it supersedes, the last posted message among them.
export const REPLACES_HEADER = 'x-kai-replaces'

export interface Replaces {
  // `regenerate` asks again for the last reply, `edit` resends a changed message.
  kind: 'regenerate' | 'edit'
  // How many of the conversation's last turns the post supersedes, the posted last message included: drop that many stored turns, append the last posted message, answer.
  turns: number
}

const REPLACES = /^(regenerate|edit):([1-9]\d{0,5})$/

// What the request says it replaces, or nothing for a fresh send.
export function replacesOf(request: Request | undefined): Replaces | undefined {
  const match = REPLACES.exec(request?.headers.get(REPLACES_HEADER) ?? '')

  return match ? { kind: match[1] as Replaces['kind'], turns: Number(match[2]) } : undefined
}

// The header a Chat holding its conversation on the server sends with each call: `send:<id>:<revision>` posts a message to the conversation as the Chat last saw it, `:<reply>` after it naming the last reply it counted in that revision, `load:<id>` (or `load` alone) and `list` read, `rename:<id>` and `remove:<id>` change it.
export const CONVERSATION_HEADER = 'x-kai-conversation'

export interface ConversationCall {
  op: 'send' | 'load' | 'list' | 'rename' | 'remove'
  // Undefined for `list`, and for a `load` of no conversation yet, which only asks whether the visitor can keep one.
  id: string | undefined
  // The revision of the conversation the Chat last saw, on a send: 0 for one not stored yet.
  revision: number
  // The reply the Chat last counted in that revision, on a send that follows one: undefined once it read the conversation.
  after?: string | undefined
}

const CONVERSATION = /^(?:list|load|(?:load|rename|remove):([\w-]{8,64})|send:([\w-]{8,64}):(\d{1,9})(?::([\w-]{8,64}))?)$/

// The id a Chat names a conversation by, which the page's `conversation` param holds.
export const CONVERSATION_ID = /^[\w-]{8,64}$/

// What the request says of the conversation it is for, or nothing for a Chat that holds its own history; a header that does not parse is a load of no conversation, so a crafted one never reaches the model.
export function conversationCallOf(request: Request | undefined): ConversationCall | undefined {
  const header = request?.headers.get(CONVERSATION_HEADER)

  if (header === undefined || header === null)
    return undefined

  const match = CONVERSATION.exec(header)

  if (!match)
    return { op: 'load', id: undefined, revision: 0 }

  const colon = header.indexOf(':')
  const op = (colon === -1 ? header : header.slice(0, colon)) as ConversationCall['op']

  return { op, id: match[1] ?? match[2], revision: Number(match[3] ?? 0), ...match[4] !== undefined && { after: match[4] } }
}
