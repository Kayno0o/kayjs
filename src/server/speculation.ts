// How eagerly Chromium prefetches a link's page: `conservative` on press, `moderate` on hover, `eager` as soon as it can.
export type Prefetch = 'conservative' | 'moderate' | 'eager' | false

const RULES = new Map<Prefetch, string>((['conservative', 'moderate', 'eager'] as const).map(eagerness => [eagerness, rules(eagerness)]))

// Browsers without speculation rules ignore the script, so a link still loads as usual there.
export function speculationRules(prefetch: Prefetch = 'moderate'): string {
  return RULES.get(prefetch) ?? ''
}

function rules(eagerness: Exclude<Prefetch, false>): string {
  const where = { and: [{ href_matches: '/*' }, { not: { href_matches: '/_kay/*' } }, { not: { selector_matches: '[data-no-prefetch]' } }] }

  return `<script type="speculationrules">${JSON.stringify({ prefetch: [{ source: 'document', where, eagerness }] })}</script>`
}
