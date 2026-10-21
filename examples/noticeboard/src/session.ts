import type { AuthSessionData } from '@kaynooo/kayjs-auth'
import { session } from 'kay/server'

// kayjs-auth keeps who is signed in in kay's own session, sealed in the cookie.
export const sessions = session<AuthSessionData>()
