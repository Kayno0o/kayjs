import type { AuthSessionData } from '@kayjs/auth'
import { session } from 'kay/server'

// kayjs-auth keeps who is signed in in kay's own session, sealed in the cookie.
export const sessions = session<AuthSessionData>()
