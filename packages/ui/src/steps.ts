// The step a URL names, and the draft a multi-step form keeps between its posts.

export interface StepItem<Key extends string = string> {
  key: Key
  label: string
}

// What `ctx.cookies` is, which is all the draft asks of it.
export interface StepCookies {
  get: (name: string) => string | null | undefined
  set: (name: string, value: string, options?: { path?: string, httpOnly?: boolean, sameSite?: 'lax' | 'strict' | 'none', maxAge?: number, secure?: boolean }) => void
  delete: (name: string, options?: { path?: string }) => void
}

const STEP_PARAM = 'step'

// The first proxy's `X-Forwarded-Proto` saying the browser came over https.
const FORWARDED_HTTPS = /^\s*https\s*(?:,|$)/i

// Not kay's own check, which the browser build of this package cannot import: an https `site` in kay.config.ts does not stand in for a proxy that passes no header.
function overHttps(request: Request): boolean {
  return new URL(request.url).protocol === 'https:' || FORWARDED_HTTPS.test(request.headers.get('x-forwarded-proto') ?? '')
}

// A browser drops a cookie past about 4 KB, and the value goes out percent-encoded, so a draft past this many encoded bytes is refused rather than lost.
const DRAFT_LIMIT = 3800

// Keys that would reach the prototype of the object the values are merged into.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// The page at `url` with its `step` param set to `key`, every other param kept and the hash dropped.
export function stepHref(url: string | URL, key: string, param: string = STEP_PARAM): string {
  const next = new URL(url, 'http://kay.invalid')

  next.searchParams.set(param, key)

  return `${next.pathname}${next.search}`
}

// The step to show: the one `url` names when it is known and no further than the first step not in `done`, else that first step; the last once every step is done.
export function currentStep<Key extends string>(url: string | URL, keys: readonly Key[], done: readonly string[] = [], param: string = STEP_PARAM): Key {
  const open = keys.findIndex(key => !done.includes(key))
  const furthest = open === -1 ? keys.length - 1 : open
  const asked = keys.indexOf(new URL(url, 'http://kay.invalid').searchParams.get(param) as Key)

  return keys[asked === -1 || asked > furthest ? furthest : asked]!
}

type Values = Record<string, unknown>

export interface StepDraft {
  // The steps whose saved values pass `check`, in the order saved.
  done: () => string[]
  // The values of each step done, by step.
  values: () => Record<string, Values>
  // The values of every step done in one object, a later step's over an earlier one's.
  merged: () => Values
  // Keeps `values` as the step's, replacing what it held.
  save: (step: string, values: Values) => void
  // Forgets the draft, once the last step has gone through, and on sign-out: the cookie is not tied to a session, so the next visitor of a shared browser would inherit it.
  clear: () => void
}

export interface StepDraftOptions {
  // Whether the values kept for `step` pass that step's schema, an `additionalProperties: false` one so no key slips in: the cookie is the visitor's to edit, so a step failing it is not done.
  check: (step: string, values: Values) => boolean
  // Seconds the draft lives; an hour by default.
  maxAge?: number | undefined
  // The path the cookie is sent to; the whole site by default, so a form living under one path narrows it.
  path?: string | undefined
  // The request being answered (`ctx.request`): the cookie is `secure` when it came over https, directly or through a proxy's `X-Forwarded-Proto`.
  request?: Request | undefined
  // Forces the cookie's `secure` flag on or off, over what `request` says.
  secure?: boolean | undefined
}

// The values of a multi-step form kept in a cookie of their own between posts, read and written from `ctx.cookies` in an action.
export function stepDraft(cookies: StepCookies, name: string, { check, maxAge = 3600, path = '/', request, secure = request !== undefined && overHttps(request) }: StepDraftOptions): StepDraft {
  const cookie = `ksteps_${name}`

  function read(): Record<string, Values> {
    try {
      const parsed: unknown = JSON.parse(cookies.get(cookie) ?? '{}', (key, value: unknown) => UNSAFE_KEYS.has(key) ? undefined : value)

      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, Values> : {}
    }
    catch {
      return {}
    }
  }

  const values = () => Object.fromEntries(Object.entries(read()).filter(([step, held]) => typeof held === 'object' && held !== null && !Array.isArray(held) && check(step, held)))

  return {
    done: () => Object.keys(values()),
    values,
    merged: () => Object.assign({}, ...Object.values(values())) as Values,
    save(step, held) {
      const text = JSON.stringify({ ...read(), [step]: held })

      if (encodeURIComponent(text).length > DRAFT_LIMIT)
        throw new RangeError(`The draft of ${name} is over ${DRAFT_LIMIT} bytes once encoded, too much for a cookie`)

      cookies.set(cookie, text, { path, httpOnly: true, sameSite: 'lax', secure, maxAge })
    },
    clear: () => cookies.delete(cookie, { path }),
  }
}
