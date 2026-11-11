import type { CheckDiagnostic, CheckOptions } from '.'
import { renamedCallOptions } from './renamed-call-options'

const CALLS = /\b(?:analytics|vitals)\b/

// `consent` in the options of `analytics()` and `vitals()`, `awaitConsent` since 1.99: it is the app's choice to wait for the visitor's yes, where `consent` is the visitor's answer (the signal of `kay/analytics`, the checkbox of a form).
// Found in the options object written in a call of either imported from `kay/analytics`; a key whose new name is written too is reported with no fix.
export async function awaitConsent(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return renamedCallOptions(root, options, {
    lint: 'deprecated-await-consent',
    needle: CALLS,
    from: source => source === 'kay/analytics',
    calls: { analytics: 0, vitals: 0 },
    renames: [['consent', 'awaitConsent']],
    since: '1.99',
    of: '`analytics()` and `vitals()`',
  })
}
