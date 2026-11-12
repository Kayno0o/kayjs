import type { RateLimitRefusal } from 'kay'
import { rateLimit } from 'kay/server'

export const seen: RateLimitRefusal[] = []

const onLimit = (refusal: RateLimitRefusal) => void seen.push(refusal)

// One limit for the guard and the action.
export const visits = rateLimit('shared-fixture', { max: 2, window: '1m', onLimit })

// One limit for a whole section, on its layout.
export const section = rateLimit('shared-section', { max: 2, window: '1m', onLimit })
