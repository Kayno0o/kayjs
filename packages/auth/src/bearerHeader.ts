const BEARER = /^Bearer\s+(\S+)$/i

// Whether a request carries an `Authorization: Bearer` token, read without loading the token code.
export function bearerRequest(request: Request): boolean {
  return BEARER.test(request.headers.get('authorization') ?? '')
}

export function bearerToken(request: Request): string | undefined {
  return BEARER.exec(request.headers.get('authorization') ?? '')?.[1]
}
