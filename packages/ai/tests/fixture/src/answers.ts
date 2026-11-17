import { s } from 'kay'

// The shape of the structured answers the fixture's actions ask a model for.
export const verdict = s.object({
  title: s.string(),
  score: s.number(),
  tags: s.list(s.string()),
  author: s.object({ name: s.string() }),
})
