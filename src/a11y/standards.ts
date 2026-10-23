import type { Violation } from './audit'
import { RGAA_CRITERIA, WCAG_CRITERIA } from './rgaa-criteria'

export type Standard = 'rgaa' | 'wcag'

// `verified`: automatic checks fully decide the criterion and found nothing on any audited page; `failed`: a check found a problem; `review`: only a person can say.
export type Status = 'verified' | 'failed' | 'review'

export interface Criterion {
  id: string
  title: string
  status: Status
  // The axe-core rules that failed it, each with the page it failed on.
  failures: { rule: string, route: string }[]
}

// The RGAA criteria an axe-core rule failing breaks. Each is the criterion whose test (RGAA 4.1 `criteres.json`, see `rgaa-criteria.ts`) the failing element fails: `image-alt` an `<img>` without an alternative is 1.1.1, `link-name` a link without a name 6.2.1, and so on.
// A rule absent here is no evidence for a criterion: its findings are reported, never filed under one.
export const RGAA_FAILS: Readonly<Record<string, readonly string[]>> = {
  'image-alt': ['1.1'],
  'role-img-alt': ['1.1'],
  'input-image-alt': ['1.1'],
  'area-alt': ['1.1'],
  'svg-img-alt': ['1.1'],
  'frame-title': ['2.1'],
  'color-contrast': ['3.2'],
  'scope-attr-valid': ['5.7'],
  'link-name': ['6.2'],
  'duplicate-id': ['8.2'],
  'duplicate-id-active': ['8.2'],
  'duplicate-id-aria': ['8.2'],
  'html-has-lang': ['8.3'],
  'html-lang-valid': ['8.4'],
  'document-title': ['8.5'],
  'valid-lang': ['8.8'],
  'heading-order': ['9.1'],
  'empty-heading': ['9.1'],
  'label': ['11.1'],
  'select-name': ['11.1'],
  'button-name': ['11.9'],
  'input-button-name': ['11.9'],
  'autocomplete-valid': ['11.13'],
  'meta-refresh': ['13.1'],
}

// The criteria whose every test the rules decide: all of them passing on a page is the criterion met there. `8.3` has one test, a `lang` on the page, and `8.5` one, a `<title>`.
// Most criteria are in no list: a rule such as `link-name` also passes a link named by `aria-label`, which 6.2.1 does not accept, and `image-alt` knows no `<object>` or `<canvas>`, so a clean run proves too little.
export const RGAA_DECIDED: Readonly<Record<string, readonly string[]>> = {
  8.3: ['html-has-lang'],
  8.5: ['document-title'],
}

// WCAG 2.1 takes what fails from the success criteria in the rules' own `wcagNNN` tags, and verifies none: 2.4.2 asks a title that describes the page and 3.1.1 the right language, which a rule cannot tell from a present one.
const SC_TAG = /^wcag\d+$/
const SC_BY_TAG = new Map(WCAG_CRITERIA.map(([id]) => [`wcag${id.replaceAll('.', '')}`, id]))

// The WCAG success criteria a rule is filed under.
function successCriteria(tags: readonly string[]): string[] {
  return tags.flatMap(tag => SC_TAG.test(tag) ? SC_BY_TAG.get(tag) ?? [] : [])
}

// Every criterion of the standard with where it stands once the routes were audited and `violations` found; `complete` is whether every page was, as a criterion is verified for the site only when it held on all of them.
export function judge(standard: Standard, violations: Violation[], complete: boolean): Criterion[] {
  const listed = standard === 'rgaa'
    ? RGAA_CRITERIA.map(([id, title]) => ({ id, title }))
    : WCAG_CRITERIA.map(([id, name, level]) => ({ id, title: `${name} (${level})` }))
  const decided = standard === 'rgaa' ? RGAA_DECIDED : {}
  const failing = new Map<string, Violation[]>()

  for (const violation of violations) {
    const ids = standard === 'rgaa' ? RGAA_FAILS[violation.rule] ?? [] : successCriteria(violation.tags)

    for (const id of ids)
      failing.set(id, [...failing.get(id) ?? [], violation])
  }

  return listed.map(({ id, title }) => {
    const found = failing.get(id) ?? []

    if (found.length > 0)
      return { id, title, status: 'failed', failures: found.map(({ rule, route }) => ({ rule, route })) }

    return { id, title, status: complete && decided[id] !== undefined ? 'verified' : 'review', failures: [] }
  })
}

// The violations no criterion of the standard takes in, so none of them is lost from the draft.
export function unfiled(standard: Standard, violations: Violation[]): Violation[] {
  return violations.filter(violation => (standard === 'rgaa' ? RGAA_FAILS[violation.rule] ?? [] : successCriteria(violation.tags)).length === 0)
}
