import type { CookieMap } from 'bun'

// A failed plain form post goes back to its page through a redirect; this cookie carries why, for that one page render.
export const FLASH_COOKIE = 'kay_failed'

export interface Flash {
  action: string
  status: number
  values: Record<string, string>
  errors: Record<string, string>
  data?: unknown
}

// Under the 4 KB browsers keep per cookie, the other cookies of the response included.
const MAX_LENGTH = 3800
const SECRET_FIELD = /pass|secret|token|cvc|cvv/i

export function writeFlash(cookies: CookieMap, flash: Flash): void {
  // The submitted values go first when it would not fit, then the handler's data: the field errors always make it.
  const candidates = [flash, { ...flash, values: {} }, { ...flash, values: {}, data: undefined }]
  const value = candidates.map(candidate => Buffer.from(JSON.stringify(candidate)).toString('base64url')).find(encoded => encoded.length <= MAX_LENGTH)

  if (value)
    cookies.set(FLASH_COOKIE, value, { httpOnly: true, sameSite: 'lax', maxAge: 60, path: '/' })
}

// Anyone can send this cookie, so its shape is checked before a page reads it; a forged one only changes what its own sender sees.
export function readFlash(cookies: CookieMap): Flash | undefined {
  const value = cookies.get(FLASH_COOKIE)

  if (!value)
    return undefined

  try {
    const flash = JSON.parse(Buffer.from(value, 'base64url').toString()) as Partial<Flash>

    return typeof flash.action === 'string' && typeof flash.status === 'number' && isTextRecord(flash.values) && isTextRecord(flash.errors) ? flash as Flash : undefined
  }
  catch {
    return undefined
  }
}

// What a form posted, as text, without the fields a page should never echo back.
export function submittedValues(body: unknown): Record<string, string> {
  const values: Record<string, string> = {}

  if (typeof body !== 'object' || body === null)
    return values

  for (const [name, value] of Object.entries(body)) {
    if (!SECRET_FIELD.test(name) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
      values[name] = String(value)
  }

  return values
}

function isTextRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && Object.values(value).every(item => typeof item === 'string')
}
