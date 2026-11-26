// HTML allow-list sanitizer applied to rendered Markdown: drops dangerous tags, non-allowlisted attributes and unsafe URL schemes.

const DROP_CONTENT_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'applet',
  'noscript',
  'template',
])

const ALLOWED_MD_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'hr', 'div', 'span', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main',
  'a', 'img', 'picture', 'source',
  'pre', 'code', 'kbd', 'samp', 'var',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'blockquote', 'q', 'cite', 'abbr', 'time', 'mark', 'small', 'ins', 'del', 's', 'u', 'b', 'i', 'strong', 'em', 'sup', 'sub', 'wbr',
  'details', 'summary', 'figure', 'figcaption',
  'input',
])

// Strict attribute allowlist: blocks event handlers (on*), data-kay-*, data-persist, DOM clobbering (id/name), style, etc.
const GLOBAL_ALLOWED_ATTRS = new Set([
  'class',
  'title',
  'lang',
  'dir',
  'role',
  'aria-label',
  'aria-hidden',
  'aria-current',
  'aria-expanded',
  'aria-level',
  'aria-description',
  'aria-roledescription',
])

const TAG_ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(['href', 'rel', 'target', 'hreflang']),
  img: new Set(['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding', 'fetchpriority']),
  source: new Set(['src', 'srcset', 'sizes', 'type', 'media', 'width', 'height']),
  blockquote: new Set(['cite']),
  q: new Set(['cite']),
  del: new Set(['cite', 'datetime']),
  ins: new Set(['cite', 'datetime']),
  time: new Set(['datetime']),
  ol: new Set(['start', 'reversed', 'type']),
  li: new Set(['value']),
  th: new Set(['colspan', 'rowspan', 'scope', 'align', 'valign', 'abbr']),
  td: new Set(['colspan', 'rowspan', 'align', 'valign', 'abbr']),
  col: new Set(['span', 'align']),
  colgroup: new Set(['span', 'align']),
  details: new Set(['open']),
}

const URL_ATTRS = new Set(['href', 'src', 'cite'])
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i
const SAFE_SCHEME_RE = /^(?:https?|mailto|tel):/i
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

function decodeHtmlEntities(rawVal: string): string {
  return rawVal
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => {
      const cp = Number.parseInt(hex, 16)
      return Number.isFinite(cp) && cp <= 0x10FFFF ? String.fromCodePoint(cp) : ''
    })
    .replace(/&#([0-9]+);?/g, (_, dec: string) => {
      const cp = Number.parseInt(dec, 10)
      return Number.isFinite(cp) && cp <= 0x10FFFF ? String.fromCodePoint(cp) : ''
    })
    .replace(/&(colon|tab|newline|amp);/gi, (_, name: string) => {
      const lower = name.toLowerCase()
      if (lower === 'colon') return ':'
      if (lower === 'tab') return '\t'
      if (lower === 'newline') return '\n'
      return '&'
    })
}

function isSafeUrl(val: string): boolean {
  const cleaned = decodeHtmlEntities(val).replace(/[\u0000-\u0020\u007F]+/g, '').trim()
  if (cleaned === '')
    return true
  if (SAFE_SCHEME_RE.test(cleaned) || SAFE_DATA_IMAGE_RE.test(cleaned))
    return true
  if (HAS_SCHEME_RE.test(cleaned))
    return false
  return true
}

function parseTagAttributes(attrSrc: string): Array<{ name: string, value: string | null }> {
  const attrs: Array<{ name: string, value: string | null }> = []
  let i = 0
  const len = attrSrc.length
  while (i < len) {
    while (i < len && /[\s/]/.test(attrSrc[i]!)) i++
    if (i >= len) break
    const nameStart = i
    while (i < len && !/[\s=/>"'<]/.test(attrSrc[i]!)) i++
    const name = attrSrc.slice(nameStart, i).toLowerCase()
    if (!name) {
      i++
      continue
    }
    while (i < len && /\s/.test(attrSrc[i]!)) i++
    if (attrSrc[i] !== '=') {
      attrs.push({ name, value: null })
      continue
    }
    i++ // skip '='
    while (i < len && /\s/.test(attrSrc[i]!)) i++
    if (i >= len) {
      attrs.push({ name, value: '' })
      break
    }
    const quote = attrSrc[i]!
    if (quote === '"' || quote === '\'') {
      i++
      const valStart = i
      while (i < len && attrSrc[i] !== quote) i++
      attrs.push({ name, value: attrSrc.slice(valStart, i) })
      if (i < len) i++
    }
    else {
      const valStart = i
      while (i < len && !/[\s>]/.test(attrSrc[i]!)) i++
      attrs.push({ name, value: attrSrc.slice(valStart, i) })
    }
  }
  return attrs
}

function sanitizeInputTag(rawAttrs: Array<{ name: string, value: string | null }>): string {
  const typeAttr = rawAttrs.find(a => a.name === 'type')
  if (typeAttr?.value?.toLowerCase() !== 'checkbox')
    return ''
  const safeParts = ['type="checkbox"']
  for (const a of rawAttrs) {
    if (a.name === 'class' && a.value !== null)
      safeParts.push(`class="${a.value.replaceAll('"', '&quot;')}"`)
    else if (a.name === 'disabled')
      safeParts.push('disabled')
    else if (a.name === 'checked')
      safeParts.push('checked')
  }
  return `<input ${safeParts.join(' ')}>`
}

type AllowedSlotPrefixes = string | ReadonlySet<string> | undefined

function matchesSlotPrefix(value: string | null, allowed: AllowedSlotPrefixes): boolean {
  if (value === null || allowed === undefined)
    return false
  if (typeof allowed === 'string')
    return value.startsWith(allowed)
  for (const prefix of allowed) {
    if (value.startsWith(prefix))
      return true
  }
  return false
}

function isAllowedAttr(tagName: string, name: string, value: string | null, slotPrefixes: AllowedSlotPrefixes): boolean {
  if (tagName === 'div' && name === 'data-kay-md-slot')
    return matchesSlotPrefix(value, slotPrefixes)
  return GLOBAL_ALLOWED_ATTRS.has(name) || TAG_ALLOWED_ATTRS[tagName]?.has(name) === true
}

function sanitizeAttributes(
  tagName: string,
  rawAttrs: Array<{ name: string, value: string | null }>,
  slotPrefixes: AllowedSlotPrefixes,
): string[] {
  const safeParts: string[] = []
  for (const a of rawAttrs) {
    if (!isAllowedAttr(tagName, a.name, a.value, slotPrefixes))
      continue
    if (URL_ATTRS.has(a.name)) {
      if (a.value === null || !isSafeUrl(a.value))
        continue
    }
    else if (a.name === 'srcset' && a.value !== null) {
      const candidates = a.value.split(',').map(s => s.trim().split(/\s+/)[0] ?? '')
      if (!candidates.every(isSafeUrl))
        continue
    }
    if (a.value === null)
      safeParts.push(a.name)
    else
      safeParts.push(`${a.name}="${a.value.replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}"`)
  }
  return safeParts
}

function findTagEndOffset(html: string, start: number): number {
  let tagEnd = start
  const len = html.length
  let inQuote: string | null = null
  while (tagEnd < len) {
    const c = html[tagEnd]!
    if (inQuote !== null) {
      if (c === inQuote)
        inQuote = null
    }
    else if (c === '"' || c === '\'') {
      inQuote = c
    }
    else if (c === '>') {
      return tagEnd
    }
    tagEnd++
  }
  return -1
}

function sanitizePass(html: string, slotPrefixes: AllowedSlotPrefixes): string {
  let out = ''
  let i = 0
  const len = html.length

  while (i < len) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      out += html.slice(i)
      break
    }
    out += html.slice(i, lt)

    // Strip HTML comments (including HTML5 `--!>` closer)
    if (html.startsWith('<!--', lt)) {
      const endStd = html.indexOf('-->', lt + 4)
      const endBang = html.indexOf('--!>', lt + 4)
      if (endStd === -1 && endBang === -1)
        i = len
      else if (endBang !== -1 && (endStd === -1 || endBang < endStd))
        i = endBang + 4
      else
        i = endStd + 3
      continue
    }

    let pos = lt + 1
    const isClosing = html[pos] === '/'
    if (isClosing)
      pos++

    const nameStart = pos
    while (pos < len && /[A-Za-z0-9:-]/.test(html[pos]!)) pos++
    const tagName = html.slice(nameStart, pos).toLowerCase()
    if (!tagName) {
      out += '&lt;'
      i = lt + 1
      continue
    }

    const tagEnd = findTagEndOffset(html, pos)
    if (tagEnd === -1)
      break

    const attrSrc = html.slice(pos, tagEnd)
    const selfClosing = !isClosing && /\/\s*$/.test(attrSrc)
    i = tagEnd + 1

    if (!isClosing && DROP_CONTENT_TAGS.has(tagName)) {
      if (!selfClosing) {
        const closeRe = new RegExp(`</${tagName}\\b[^>]*>`, 'gi')
        closeRe.lastIndex = i
        const m = closeRe.exec(html)
        i = m ? m.index + m[0].length : len
      }
      continue
    }

    if (!ALLOWED_MD_TAGS.has(tagName))
      continue

    if (isClosing) {
      if (tagName !== 'input' && tagName !== 'br' && tagName !== 'hr' && tagName !== 'img')
        out += `</${tagName}>`
      continue
    }

    const rawAttrs = parseTagAttributes(attrSrc)
    if (tagName === 'input') {
      out += sanitizeInputTag(rawAttrs)
      continue
    }

    const safeParts = sanitizeAttributes(tagName, rawAttrs, slotPrefixes)
    const attrOut = safeParts.length > 0 ? ` ${safeParts.join(' ')}` : ''
    out += selfClosing ? `<${tagName}${attrOut} />` : `<${tagName}${attrOut}>`
  }

  return out
}

export function sanitizeMarkdownHtml(html: string, slotPrefixes?: AllowedSlotPrefixes): string {
  let current = html
  for (let pass = 0; pass < 3; pass++) {
    const next = sanitizePass(current, slotPrefixes)
    if (next === current)
      return next
    current = next
  }
  return current
}
