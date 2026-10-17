export type AiErrorKind
  // The provider refused the key (401, 403).
  = | 'auth'
  // Too many requests (429): `retryAfter` is the seconds the provider asked to wait, when it said.
    | 'rate-limited'
  // The provider is down or overloaded (5xx, or an error event in the stream).
    | 'unavailable'
  // The provider refused the request (another 4xx): a model it does not know, a message it cannot take.
    | 'invalid'
  // The provider could not be reached.
    | 'network'
  // The provider took longer than the `timeout` of `ask` to answer, or to send the next event: `partial` holds what came.
    | 'timeout'
  // The stream ended before the provider said the reply was done: `partial` holds what came.
    | 'cut'
  // The provider sent something that is no server-sent event of its API.
    | 'protocol'
  // The visitor or the chat is over a limit or budget set in `ai()`: `retryAfter` is the seconds until its window closes, `limit` which one.
    | 'limited'

// Which limit refused an ask: `asks` is `limit`, `budget` the visitor's tokens, `total` the tokens of all visitors.
export type AiLimit = 'asks' | 'budget' | 'total'

// What kay answers an action with when its handler throws an error carrying this: the status, `Retry-After` and the visitor's words, not a 500.
const REFUSED = Symbol.for('kay.refused')

const VISITOR_WORDS: Record<AiLimit, string> = {
  asks: 'Too many questions',
  budget: 'You have asked enough for now',
  total: 'The chat is busy right now',
}

export interface AiErrorDetails {
  limit?: AiLimit | undefined
  status?: number | undefined
  retryAfter?: number | undefined
  partial?: string | undefined
  cause?: unknown
}

export class AiError extends Error {
  override readonly name = 'AiError'
  readonly kind: AiErrorKind
  readonly status: number | undefined
  readonly retryAfter: number | undefined
  // Which limit refused the ask, for a `limited` error.
  readonly limit: AiLimit | undefined
  // The text received before a reply was cut or failed, filled in by the reply.
  partial: string | undefined
  declare readonly [REFUSED]?: { status: number, retryAfter: number | undefined, message: string }

  constructor(kind: AiErrorKind, message: string, { status, retryAfter, partial, limit, cause }: AiErrorDetails = {}) {
    super(`kayjs-ai: ${message}`, { cause })
    this.kind = kind
    this.status = status
    this.retryAfter = retryAfter
    this.partial = partial
    this.limit = limit

    if (kind === 'limited') {
      Object.defineProperty(this, REFUSED, { value: { status: 429, retryAfter, message: `${VISITOR_WORDS[limit ?? 'asks']}; try again${retryAfter === undefined ? ' later' : ` in ${retryAfter} s`}` } })
    }
  }
}
