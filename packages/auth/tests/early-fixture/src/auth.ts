import type { AuthSessionData } from '../../../src/auth'
import { session } from 'kay/server'
import { authCore } from '../../../src/auth'
import { memoryAuth } from '../../../src/memoryStore'

export const store = memoryAuth()

export const auth = authCore({ sessions: session<AuthSessionData>(), store, site: 'http://localhost', name: 'Early' })
