export interface TokenReply {
  status: number
  body: Record<string, unknown>
}

// An OAuth error answer: the code and a sentence for the developer.
export function refused(error: string, description: string, status = 400): TokenReply {
  return { status, body: { error, error_description: description } }
}
