import type { Rating, Vital, VitalSummary } from './vitals-store'
import { wording } from '../runtime/words.server'
import { GOOD } from './vitals-store'

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

export function limitText(vital: Vital): string {
  if (vital === 'cls')
    return String(GOOD.cls / 1000)

  return vital === 'lcp' ? `${GOOD.lcp / 1000} s` : `${GOOD.inp} ms`
}
