import { s } from 'kay'

// The shape of the structured answers the fixture's actions ask a model for.
export const verdict = s.Object({
  title: s.String(),
  score: s.Number(),
  tags: s.Array(s.String()),
  author: s.Object({ name: s.String() }),
})
