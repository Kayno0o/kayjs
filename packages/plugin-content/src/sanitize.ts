// HTML allow-list sanitizer applied to rendered Markdown: drops dangerous tags, attributes and URL schemes.

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

const URL_ATTRS = new Set(['href', 'src', 'cite', 'poster', 'action', 'formaction'])
const FORBIDDEN_ATTRS = new Set(['srcdoc', 'action', 'formaction', 'xmlns', 'xlink:href', 'style', 'is', 'data-persist'])
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

function sanitizePass(html: string): string {
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

    // Parse tag start
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

    // Find tag end respecting quoted attribute values
    let tagEnd = pos
    let inQuote: string | null = null
    while (tagEnd < len) {
      const c = html[tagEnd]!
      if (inQuote !== null) {
        if (c === inQuote)
          inQuote = null
      }
      else {
        if (c === '"' || c === '\'')
          inQuote = c
        else if (c === '>')
          break
      }
      tagEnd++
    }
    if (tagEnd >= len) {
      // Unclosed tag at EOF: drop it
      break
    }

    const attrSrc = html.slice(pos, tagEnd)
    const selfClosing = !isClosing && /\/\s*$/.test(attrSrc)
    i = tagEnd + 1

    // Drop dangerous container tags together with their inner content
    if (!isClosing && DROP_CONTENT_TAGS.has(tagName)) {
      if (!selfClosing) {
        const closeRe = new RegExp(`</${tagName}\\b[^>]*>`, 'gi')
        closeRe.lastIndex = i
        const m = closeRe.exec(html)
        i = m ? m.index + m[0].length : len
      }
      continue
    }

    // Strip any non-allowlisted tag (e.g. <embed>, <form>, <base>, <meta>, <link>, <svg>, etc.)
    if (!ALLOWED_MD_TAGS.has(tagName))
      continue

    if (isClosing) {
      if (tagName !== 'input' && tagName !== 'br' && tagName !== 'hr' && tagName !== 'img')
        out += `</${tagName}>`
      continue
    }

    const rawAttrs = parseTagAttributes(attrSrc)

    // Allow <input> strictly for GFM tasklist checkboxes
    if (tagName === 'input') {
      const typeAttr = rawAttrs.find(a => a.name === 'type')
      if (typeAttr?.value?.toLowerCase() !== 'checkbox')
        continue
      const safeParts = ['type="checkbox"']
      for (const a of rawAttrs) {
        if (a.name === 'class' && a.value !== null)
          safeParts.push(`class="${a.value.replaceAll('"', '&quot;')}"`)
        else if (a.name === 'disabled')
          safeParts.push('disabled')
        else if (a.name === 'checked')
          safeParts.push('checked')
      }
      out += `<input ${safeParts.join(' ')}>`
      continue
    }

    const safeParts: string[] = []
    for (const a of rawAttrs) {
      if (a.name.startsWith('on') || FORBIDDEN_ATTRS.has(a.name))
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

    const attrOut = safeParts.length > 0 ? ` ${safeParts.join(' ')}` : ''
    out += selfClosing ? `<${tagName}${attrOut} />` : `<${tagName}${attrOut}>`
  }

  return out
}

export function sanitizeMarkdownHtml(html: string): string {
  let current = html
  for (let pass = 0; pass < 3; pass++) {
    const next = sanitizePass(current)
    if (next === current)
      return next
    current = next
  }
  return current
}
