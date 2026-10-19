import type { Static } from 'kay'
import { s } from 'kay'

export const choice = s.Union([s.Literal('smash'), s.Literal('pass')])
export type Choice = Static<typeof choice>
