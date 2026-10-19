// What a way of signing in takes after its credentials, as a trailing options object: where to go next, whether the session is remembered, and the CAPTCHA widget's token. A method takes the ones it uses.
export interface SignInOptions {
  // Where to go once signed in, a path on the site; the pages' home, `/` by default.
  redirect?: string | undefined
  // Whether the session lasts `rememberMaxAge` (true) or until the browser closes (false), when the sign-in form asks; the session plugin's own lifetime without it.
  remember?: boolean | undefined
  // The CAPTCHA widget's token, when the app asks for one.
  captcha?: string | undefined
}
