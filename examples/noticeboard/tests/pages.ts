import type { Action } from 'kay'
import * as accountLayout from '@kaynooo/kayjs-auth/pages/account/_layout.kay'
import * as account from '@kaynooo/kayjs-auth/pages/account/index.kay'
import * as magicLinkPage from '@kaynooo/kayjs-auth/pages/magic-link.kay'
import * as registerPage from '@kaynooo/kayjs-auth/pages/register.kay'
import * as resetPage from '@kaynooo/kayjs-auth/pages/reset-password.kay'
import * as signInPage from '@kaynooo/kayjs-auth/pages/sign-in.kay'
import * as verifyPage from '@kaynooo/kayjs-auth/pages/verify-email.kay'

// The actions of kayjs-auth's prebuilt pages, which a test submits as the pages' forms do. kay types a library's `.kay` module by its default export alone, so each action is typed here by its fields.
type Form<Input> = Action<Input, unknown>

export const signOut = (accountLayout as unknown as { signOut: Form<Record<string, never>> }).signOut
export const changeUsername = (account as unknown as { changeUsername: Form<{ username: string }> }).changeUsername
export const spend = (magicLinkPage as unknown as { spend: Form<{ token: string }> }).spend
export const register = (registerPage as unknown as { register: Form<{ email: string, password: string }> }).register
export const request = (resetPage as unknown as { request: Form<{ email: string }> }).request
export const reset = (resetPage as unknown as { reset: Form<{ token: string, password: string }> }).reset
export const password = (signInPage as unknown as { password: Form<{ identifier: string, password: string, redirect?: string }> }).password
export const magicLink = (signInPage as unknown as { magicLink: Form<{ email: string }> }).magicLink
export const verify = (verifyPage as unknown as { verify: Form<{ token: string, password?: string }> }).verify
