import { s } from 'kay'

// What Chat posts, as the docs have an app declare it.
export const messages = s.Object({ messages: s.Array(s.Object({ role: s.UnionEnum(['user', 'assistant']), content: s.String({ maxLength: 4000 }) }), { minItems: 1, maxItems: 50 }) })
