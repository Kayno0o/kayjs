import type { Rating, Vital, VitalSummary } from './vitals-store'
import { wording } from '../runtime/words.server'

export const RATING_LABELS: Record<Rating, () => string> = {
  'good': () => wording('kay.vitals.good', 'Good'),
  'needs-improvement': () => wording('kay.vitals.needsImprovement', 'Needs improvement'),
  'poor': () => wording('kay.vitals.poor', 'Poor'),
}

// A number as the screen shows it: seconds for LCP, the score for CLS, milliseconds for INP.
export function shown(vital: Vital, summary: VitalSummary): string {
  if (vital === 'cls')
    return summary.value.toFixed(summary.value < 0.01 ? 3 : 2)

  return vital === 'lcp' ? `${(summary.value / 1000).toFixed(1)} s` : `${Math.round(summary.value)} ms`
}

const GOOD_TEXT: Record<Vital, string> = { lcp: '2.5 s', cls: '0.1', inp: '200 ms' }

export function limitText(vital: Vital): string {
  return GOOD_TEXT[vital]
}
