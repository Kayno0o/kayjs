// What the WAI-ARIA 1.2 and HTML specs allow, for the a11y lints to hold markup to.

export const ARIA_ATTRIBUTES: ReadonlySet<string> = new Set([
  'aria-activedescendant',
  'aria-atomic',
  'aria-autocomplete',
  'aria-braillelabel',
  'aria-brailleroledescription',
  'aria-busy',
  'aria-checked',
  'aria-colcount',
  'aria-colindex',
  'aria-colindextext',
  'aria-colspan',
  'aria-controls',
  'aria-current',
  'aria-describedby',
  'aria-description',
  'aria-details',
  'aria-disabled',
  'aria-dropeffect',
  'aria-errormessage',
  'aria-expanded',
  'aria-flowto',
  'aria-grabbed',
  'aria-haspopup',
  'aria-hidden',
  'aria-invalid',
  'aria-keyshortcuts',
  'aria-label',
  'aria-labelledby',
  'aria-level',
  'aria-live',
  'aria-modal',
  'aria-multiline',
  'aria-multiselectable',
  'aria-orientation',
  'aria-owns',
  'aria-placeholder',
  'aria-posinset',
  'aria-pressed',
  'aria-readonly',
  'aria-relevant',
  'aria-required',
  'aria-roledescription',
  'aria-rowcount',
  'aria-rowindex',
  'aria-rowindextext',
  'aria-rowspan',
  'aria-selected',
  'aria-setsize',
  'aria-sort',
  'aria-valuemax',
  'aria-valuemin',
  'aria-valuenow',
  'aria-valuetext',
])

// The roles an element may take, those of the Digital Publishing and Graphics modules included.
export const ROLES: ReadonlySet<string> = new Set([
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'comment',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'image',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'mark',
  'marquee',
  'math',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'meter',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'suggestion',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
  'doc-abstract',
  'doc-acknowledgments',
  'doc-afterword',
  'doc-appendix',
  'doc-backlink',
  'doc-biblioentry',
  'doc-bibliography',
  'doc-biblioref',
  'doc-chapter',
  'doc-colophon',
  'doc-conclusion',
  'doc-cover',
  'doc-credit',
  'doc-credits',
  'doc-dedication',
  'doc-endnote',
  'doc-endnotes',
  'doc-epigraph',
  'doc-epilogue',
  'doc-errata',
  'doc-example',
  'doc-footnote',
  'doc-foreword',
  'doc-glossary',
  'doc-glossref',
  'doc-index',
  'doc-introduction',
  'doc-noteref',
  'doc-notice',
  'doc-pagebreak',
  'doc-pagefooter',
  'doc-pageheader',
  'doc-pagelist',
  'doc-part',
  'doc-preface',
  'doc-prologue',
  'doc-pullquote',
  'doc-qna',
  'doc-subtitle',
  'doc-tip',
  'doc-toc',
  'graphics-document',
  'graphics-object',
  'graphics-symbol',
])

// Roles the spec defines only for others to build on, which no element may take.
export const ABSTRACT_ROLES: ReadonlySet<string> = new Set(['command', 'composite', 'input', 'landmark', 'range', 'roletype', 'section', 'sectionhead', 'select', 'structure', 'widget', 'window'])

// Roles of the controls a person operates, and of the composites holding them, which a click handler may stand behind.
export const WIDGET_ROLES: ReadonlySet<string> = new Set(['button', 'checkbox', 'columnheader', 'combobox', 'grid', 'gridcell', 'link', 'listbox', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'radiogroup', 'row', 'rowheader', 'scrollbar', 'searchbox', 'separator', 'slider', 'spinbutton', 'switch', 'tab', 'tablist', 'textbox', 'toolbar', 'tree', 'treegrid', 'treeitem'])

// The states a role needs to be announced at all, such as whether a checkbox is checked.
export const REQUIRED_STATES: ReadonlyMap<string, string[]> = new Map([
  ['checkbox', ['aria-checked']],
  ['combobox', ['aria-expanded']],
  ['heading', ['aria-level']],
  ['menuitemcheckbox', ['aria-checked']],
  ['menuitemradio', ['aria-checked']],
  ['meter', ['aria-valuenow']],
  ['radio', ['aria-checked']],
  ['scrollbar', ['aria-controls', 'aria-valuenow']],
  ['slider', ['aria-valuenow']],
  ['switch', ['aria-checked']],
])

// The field names of HTML's autofill, a contact one taking `home`, `work`, `mobile`, `fax` or `pager` before it.
const AUTOFILL_FIELDS = new Set(['name', 'honorific-prefix', 'given-name', 'additional-name', 'family-name', 'honorific-suffix', 'nickname', 'username', 'new-password', 'current-password', 'one-time-code', 'organization-title', 'organization', 'street-address', 'address-line1', 'address-line2', 'address-line3', 'address-level4', 'address-level3', 'address-level2', 'address-level1', 'country', 'country-name', 'postal-code', 'cc-name', 'cc-given-name', 'cc-additional-name', 'cc-family-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-type', 'transaction-currency', 'transaction-amount', 'language', 'bday', 'bday-day', 'bday-month', 'bday-year', 'sex', 'url', 'photo'])
const CONTACT_FIELDS = new Set(['tel', 'tel-country-code', 'tel-national', 'tel-area-code', 'tel-local', 'tel-local-prefix', 'tel-local-suffix', 'tel-extension', 'email', 'impp'])
const CONTACT_KINDS = new Set(['home', 'work', 'mobile', 'fax', 'pager'])
const ADDRESS_KINDS = new Set(['shipping', 'billing'])
const WHITESPACE = /\s+/

// Whether an `autocomplete` value is one browsers understand: `on`, `off`, or `[section-*] [shipping|billing] [home|work|...] field [webauthn]`.
export function validAutocomplete(value: string): boolean {
  const tokens = value.trim().toLowerCase().split(WHITESPACE)

  if (tokens.length === 1 && (tokens[0] === 'on' || tokens[0] === 'off'))
    return true

  if (tokens.at(-1) === 'webauthn')
    tokens.pop()

  if (tokens[0]?.startsWith('section-'))
    tokens.shift()

  if (ADDRESS_KINDS.has(tokens[0] ?? ''))
    tokens.shift()

  if (tokens.length === 2 && CONTACT_KINDS.has(tokens[0]!))
    return CONTACT_FIELDS.has(tokens[1]!)

  return tokens.length === 1 && (AUTOFILL_FIELDS.has(tokens[0]!) || CONTACT_FIELDS.has(tokens[0]!))
}

// The known name closest to a misspelled one, such as `aria-labelledby` for `aria-labeledby`, when one is close enough to be what was meant.
export function closest(name: string, known: Iterable<string>): string | undefined {
  let best: string | undefined
  let bestDistance = Math.max(2, Math.floor(name.length / 4)) + 1

  for (const candidate of known) {
    const distance = editDistance(name, candidate)

    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }

  return best
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (let i = 1; i <= a.length; i++) {
    const current = [i]

    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))

    previous = current
  }

  return previous[b.length]!
}
