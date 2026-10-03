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
// A field name holding one of these anywhere is a secret: `newPassword`, `accessToken`.
const SECRET_PART = /password|passwd|passphrase|passcode|secret|token|apikey/i
// These only as a whole word of the name, so `passenger` and `shipping` are echoed: `pin`, `card_number`, `apiKey`.
const SECRET_WORDS = new Set(['pass', 'pwd', 'pin', 'otp', 'ssn', 'cvc', 'cvv', 'csc', 'key', 'card', 'iban'])
// The words of a camelCase, snake_case or kebab-case name, an acronym such as `API` counting as one.
const WORD = /[A-Z]?[a-z\d]+|[A-Z]+(?![a-z])/g

export function writeFlash(cookies: CookieMap, flash: Flash): void {
  // The submitted values go first when it would not fit, then the handler's data: the field errors always make it.
  const candidates = [flash, { ...flash, values: {} }, { ...flash, values: {}, data: undefined }]
  const encoded = candidates.map(candidate => Buffer.from(JSON.stringify(candidate)).toString('base64url'))
  const fits = encoded.findIndex(value => value.length <= MAX_LENGTH)

  if (fits === candidates.length - 1 && flash.data !== undefined)
    console.warn(`kay: what ${flash.action} passed to ctx.fail is too big for the cookie carrying it back to the page, which reads no data`)

  if (fits !== -1)
    cookies.set(FLASH_COOKIE, encoded[fits]!, { httpOnly: true, sameSite: 'lax', maxAge: 60, path: '/' })
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
    if (!isSecret(name) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
      values[name] = String(value)
  }

  return values
}

function isSecret(name: string): boolean {
  return SECRET_PART.test(name) || (name.match(WORD) ?? []).some(word => SECRET_WORDS.has(word.toLowerCase()))
}

function isTextRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && Object.values(value).every(item => typeof item === 'string')
}
