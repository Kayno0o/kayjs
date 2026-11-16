import type { ErrorName } from '../compiler/errors'

// An error kay raised itself, its code the one `kay explain` documents.
// `kind` tells apart what one code covers (an `AiError`'s `auth` from its `schema`) and is the code when a code covers one cause, `status` is the HTTP status the error stands for, and `cause` is the error underneath.
// Kept apart from the error table in `compiler/errors`, so an island that throws one carries the class and not the table.
export interface KayErrorOptions extends ErrorOptions {
  kind?: string | undefined
  status?: number | undefined
}

let onRaised: ((error: KayError) => void) | undefined

// The build keeps the errors raised, so a failed bundle can name their codes.
export function watchRaised(watch: (error: KayError) => void): void {
  onRaised = watch
}

export class KayError extends Error {
  override name = 'KayError'
  readonly kind: string
  readonly status: number | undefined

  constructor(readonly code: ErrorName, message: string, { kind, status, ...options }: KayErrorOptions = {}) {
    super(message, options)
    this.kind = kind ?? code
    this.status = status
    onRaised?.(this)
  }
}
