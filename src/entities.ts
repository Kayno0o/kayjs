// The named entities a page may hold: HTML's own, Latin-1's from `nbsp` (U+00A0) on, and typography's.
const LATIN_1 = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '\'',
  OElig: 'Œ',
  oelig: 'œ',
  Scaron: 'Š',
  scaron: 'š',
  Yuml: 'Ÿ',
  ndash: '–',
  mdash: '\u2014',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  hellip: '…',
  ZeroWidthSpace: '\u200B',
  zwnj: '\u200C',
  zwj: '\u200D',
  bull: '•',
  prime: '′',
  Prime: '″',
  euro: '€',
  trade: '™',
  larr: '←',
  rarr: '→',
  ...Object.fromEntries(LATIN_1.split(' ').map((name, index) => [name, String.fromCodePoint(0xA0 + index)])),
}

// The character a named entity stands for, tried as written and then in lower case; `undefined` for any other name.
export function namedEntity(name: string): string | undefined {
  const key = Object.hasOwn(ENTITIES, name) ? name : name.toLowerCase()

  return Object.hasOwn(ENTITIES, key) ? ENTITIES[key] : undefined
}
