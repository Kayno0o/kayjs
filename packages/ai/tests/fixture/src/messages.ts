import { s } from 'kay'

// What Chat posts, as the docs have an app declare it.
export const messages = s.object({ messages: s.list(s.object({ role: s.enum(['user', 'assistant']), content: s.string({ max: 4000 }) }), { min: 1, max: 50 }) })
