import type { CheckDiagnostic, CheckOptions } from '.'
import { renamedCallOptions } from './renamed-call-options'

const CMS = /\bcms\b/

// `hide` in the form layout of a collection, `exclude` since 1.99: a filter list is spelled `include` or `exclude` in every library.
// Found in `cms({ collections: { <name>: { form: { hide } } } })` written in a call of `cms` imported from `@kaynooo/kayjs-cms`; a form holding `exclude` too is reported with no fix.
export async function filterOptions(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return renamedCallOptions(root, options, {
    lint: 'deprecated-filter-options',
    needle: CMS,
    from: source => source === '@kaynooo/kayjs-cms',
    calls: { cms: 0 },
    within: ['collections', '*', 'form'],
    renames: [['hide', 'exclude']],
    since: '1.99',
    of: 'the form layout of `cms()`',
  })
}
