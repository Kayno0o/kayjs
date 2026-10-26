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
