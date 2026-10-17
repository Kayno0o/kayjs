import { log } from './log'

// What a way of signing in takes after its credentials, as a trailing options object: where to go next, whether the session is remembered, and the CAPTCHA widget's token. A method takes the ones it uses.
export interface SignInOptions {
  // Where to go once signed in, a path on the site; the pages' home, `/` by default.
  redirect?: string | undefined
  // Whether the session lasts `rememberMaxAge` (true) or until the browser closes (false), when the sign-in form asks; the session plugin's own lifetime without it.
  remember?: boolean | undefined
  // The CAPTCHA widget's token, when the app asks for one.
  captcha?: string | undefined
}

// Each message once per process, so an app still on an old form does not log a line per sign-in.
const warned = new Set<string>()

function warnOnce(message: string) {
  if (warned.has(message))
    return

  warned.add(message)
  log.warn(message)
}

const KEYS = ['redirect', 'remember', 'captcha'] as const

// The options of a call, `options` winning key by key over the same keys of the `input` they used to sit in, which still work for now and log a warning.
export function mergeInput<Input extends SignInOptions>(method: string, input: Input, options: SignInOptions | undefined): Input {
  const old = KEYS.filter(key => input[key] !== undefined)

  if (old.length > 0)
    warnOnce(`${method}({ ${old.join(', ')} }) is renamed ${method}(input, { ${old.join(', ')} }): the options come as the second argument`)

  const merged: Input = { ...input }

  for (const key of KEYS) {
    if (options?.[key] !== undefined)
      Object.assign(merged, { [key]: options[key] })
  }

  return merged
}

// The options of a call that used to take the redirect as a string before them: `(redirect?, options?)` still works for now and logs a warning, and `options`' own redirect wins.
export function mergePositional(method: string, second: string | SignInOptions | undefined, third: SignInOptions | undefined): SignInOptions {
  if (typeof second !== 'string')
    return second ?? third ?? {}

  warnOnce(`${method}(..., redirect, options) is renamed ${method}(..., { redirect, ...options }): the redirect goes in the options`)

  return { redirect: second, ...Object.fromEntries(Object.entries(third ?? {}).filter(([, value]) => value !== undefined)) }
}
