import type { AuthSessionData } from '../../../src/auth'
import { session } from 'kay/server'
import { createAuth } from '../../../src/auth'
import { memoryAuthStore } from '../../../src/memoryStore'

export const store = memoryAuthStore()

export const auth = createAuth({ sessions: session<AuthSessionData>(), store, site: 'http://localhost', name: 'Early' })
