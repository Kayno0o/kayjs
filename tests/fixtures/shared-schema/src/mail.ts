import type { InputOf } from 'kay'
import type { castVerdict } from './routes/index.kay'

export function describeCast(cast: InputOf<typeof castVerdict>): string {
  return cast.choice === 'smash' ? 'smashed' : 'passed'
}
