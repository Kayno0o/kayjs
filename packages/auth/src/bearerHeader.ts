const BEARER = /^Bearer\s+(\S+)$/i

// Whether a request carries an `Authorization: Bearer` token, which no page can add to a cross-site request (a browser sends Basic credentials on its own), read without loading the token code.
export function bearerRequest(request: Request): boolean {
  return BEARER.test(request.headers.get('authorization') ?? '')
}

// The token itself, if there is one.
export function bearerToken(request: Request): string | undefined {
  return BEARER.exec(request.headers.get('authorization') ?? '')?.[1]
}
