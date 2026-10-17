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
  // The stream ended before the provider said the reply was done: `partial` holds what came.
    | 'cut'
  // The provider sent something that is no server-sent event of its API.
    | 'protocol'

export interface AiErrorDetails {
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
  // The text received before a reply was cut or failed, filled in by the reply.
  partial: string | undefined

  constructor(kind: AiErrorKind, message: string, { status, retryAfter, partial, cause }: AiErrorDetails = {}) {
    super(`kayjs-ai: ${message}`, { cause })
    this.kind = kind
    this.status = status
    this.retryAfter = retryAfter
    this.partial = partial
  }
}
