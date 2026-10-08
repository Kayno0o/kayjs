import type { AuthSessionData } from '@kaynooo/kayjs-auth'
import { session } from 'kay/server'
import { env } from './env'

// kayjs-auth keeps who is signed in in kay's own session, sealed in the cookie.
export const sessions = session<AuthSessionData>({ secret: env.SESSION_SECRET })
