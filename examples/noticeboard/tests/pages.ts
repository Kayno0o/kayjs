import type { TestSite } from 'kay/test'

export { changeUsername } from '@kayjs/auth/pages/account/index.kay'
export { spend } from '@kayjs/auth/pages/magic-link.kay'
export { register } from '@kayjs/auth/pages/register.kay'
export { request, reset } from '@kayjs/auth/pages/reset-password.kay'
export { magicLink, password } from '@kayjs/auth/pages/sign-in.kay'
export { verify } from '@kayjs/auth/pages/verify-email.kay'

// The account page's button, a form posting to kayjs-auth's own sign-out route.
export async function signOut(site: TestSite) {
  return site.fetch('/auth/sign-out', { method: 'POST' })
}
