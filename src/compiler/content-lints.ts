import type { Lint } from './lints'

// The lints of the content collections' entries, with the other lints in `LINTS`.
export const CONTENT_LINTS = {
  'held-back-reference': {
    level: 'warn',
    group: 'code',
    site: true,
    summary: 'An entry shown on the site whose `reference()` field names an entry its collection holds back from production, a draft or one outside its `publishAt` and `unpublishAt` dates, so the page renders without it. `kay check` only notes it, as publishing the referenced entry fixes it, and the build does not fail.',
    wrong: 'author: ada (in an entry shown, while authors/ada.md has `draft: true`)',
    right: 'publish authors/ada.md, or point the reference at a shown entry',
  },
} as const satisfies Record<string, Lint>
