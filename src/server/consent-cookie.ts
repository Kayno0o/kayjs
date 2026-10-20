// The `kay_analytics` cookie the notice and the opt-out write, which every extension counting visitors reads.
const CONSENT_COOKIE = 'kay_analytics=yes'
const OPT_OUT_COOKIE = 'kay_analytics=no'

// A gated count needs the visitor's yes; one made without asking stops for a visitor who opted out.
export function declined(request: Request, gated: boolean): boolean {
  const cookies = new Set((request.headers.get('cookie') ?? '').split(';').map(cookie => cookie.trim()))

  return gated ? !cookies.has(CONSENT_COOKIE) : cookies.has(OPT_OUT_COOKIE)
}
