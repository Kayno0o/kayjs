import type { CookieMap } from 'bun'
import { isSecret } from '../runtime/form'
import { decodeValue, encodeValue, unsendable } from '../runtime/wire'

// A plain form post that succeeded goes back to its page through a redirect; this cookie carries what it returned, for that one page render.
export const FLASH_COOKIE = 'kay_flash'

export interface Flash {
  action: string
  status: number
  values: Record<string, string>
  errors: Record<string, string>
  data?: unknown
}

// What the handler of a post that succeeded returned.
export interface SuccessFlash {
  action: string
  succeeded: true
  data: unknown
}

// Under the 4 KB browsers keep per cookie, the other cookies of the response included.
const MAX_LENGTH = 3800

// A refused plain form post's page renders as a visit through the app; this header names how the post went, kept in memory under an id nobody can guess, for that one render.
const HANDED_OVER = 'x-kay-refused'
const handedOver = new Map<string, Flash>()

// Gives back what forgets it once the page rendered.
export function handOver(headers: Headers, flash: Flash): () => void {
  const id = crypto.randomUUID()

  handedOver.set(id, flash)
  headers.set(HANDED_OVER, id)

  return () => handedOver.delete(id)
}

export function handedOverFlash(request: Request): Flash | undefined {
  const id = request.headers.get(HANDED_OVER)

  return id === null ? undefined : handedOver.get(id)
}

// The page the browser goes back to reads it through `ctx.succeeded`, unless it cannot be carried there.
export function writeSuccess(cookies: CookieMap, success: SuccessFlash, secure = false): void {
  const refusal = setFlash(cookies, success, secure)

  if (refusal !== undefined)
    console.warn(`kay: what ${success.action} returned cannot reach the page through its cookie: ${refusal}`)
}

// Sets the cookie, or says why it cannot: too big, or holding what has no encoding.
function setFlash(cookies: CookieMap, value: SuccessFlash, secure: boolean): string | undefined {
  let encoded: string

  try {
    encoded = Buffer.from(encodeValue(value)).toString('base64url')
  }
  catch (error) {
    const reason = unsendable(error)

    if (reason === undefined)
      throw error

    return reason
  }

  if (encoded.length > MAX_LENGTH)
    return `it takes ${encoded.length} bytes, over the ${MAX_LENGTH} it may`

  cookies.set(FLASH_COOKIE, encoded, { httpOnly: true, sameSite: 'lax', maxAge: 60, path: '/', secure })

  return undefined
}

// Anyone can send this cookie, so its shape is checked before a page reads it; a forged one only changes what its own sender sees.
export function readFlash(cookies: CookieMap): SuccessFlash | undefined {
  const value = cookies.get(FLASH_COOKIE)

  if (value === null || value === '')
    return undefined

  try {
    const flash = decodeValue(Buffer.from(value, 'base64url').toString()) as Partial<SuccessFlash> | null

    return typeof flash === 'object' && flash !== null && typeof flash.action === 'string' && flash.succeeded === true ? flash as SuccessFlash : undefined
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
