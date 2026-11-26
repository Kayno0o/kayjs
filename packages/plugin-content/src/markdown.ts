// renderMarkdown: Bun's native Markdown renderer plus highlight hook, embedded components, heading ids and TOC.

import type { ContentHeading, MarkdownImageResolver, MarkdownImageResult, RenderMarkdownOptions } from './index'
import { escAttr } from '@kayjs/kay/server'
import { currentApp } from './app'
import { expandComponents } from './components'
import { sanitizeMarkdownHtml } from './sanitize'

function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section'
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', '\'')
    .replaceAll('&amp;', '&')
    .trim()
}

function findDefaultImageResolver(file: string | undefined): MarkdownImageResolver | undefined {
  if (!file)
    return undefined
  return currentApp.imageResolver()
}

const FENCE_RE = /^([`~]{3,})([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm
let slotBatchId = 0

function renderMarkdownInternal(
  body: string,
  options: RenderMarkdownOptions,
  inheritedSlotPrefixes?: ReadonlySet<string>,
): {
  html: string
  headings: ContentHeading[]
  wordCount: number
  readingMinutes: number
} {
  const slots: string[] = []
  // Cryptographically unguessable per-render slot prefix so untrusted markdown cannot forge or duplicate component slots.
  const slotPrefix = `b${++slotBatchId}-${crypto.randomUUID().slice(0, 12)}-`
  const allowedSlotPrefixes = new Set<string>(inheritedSlotPrefixes)
  allowedSlotPrefixes.add(slotPrefix)
  let processed = body

  // 1. Extract fenced code blocks before component expansion so `<Tag>` inside ```code``` is never treated as a component
  if (options.highlight !== undefined || options.components !== undefined) {
    processed = processed.replace(FENCE_RE, (full, _fence: string, info: string, code: string) => {
      if (options.highlight !== undefined) {
        const lang = info.trim().split(/\s+/)[0] || undefined
        const idx = slots.length
        slots.push(options.highlight(code.replace(/\n$/, ''), lang))
        return `\n\n<div data-kay-md-slot="${slotPrefix}${idx}"></div>\n\n`
      }
      // Protect code fences from component expansion when only components are configured
      const idx = slots.length
      slots.push(Bun.markdown.html(full, { tables: true, strikethrough: true, tasklists: true, autolinks: true }))
      return `\n\n<div data-kay-md-slot="${slotPrefix}${idx}"></div>\n\n`
    })
  }

  // 2. Expand embedded TSX components
  if (options.components !== undefined) {
    processed = expandComponents(
      processed,
      options.components,
      options,
      slots,
      slotPrefix,
      (innerMd, innerOpts) => renderMarkdownInternal(innerMd, innerOpts, allowedSlotPrefixes),
    )
  }

  // 3. Render remaining Markdown via native Zig Bun.markdown.html
  let html = Bun.markdown.html(processed, {
    tables: true,
    strikethrough: true,
    tasklists: true,
    autolinks: true,
  })

  // 3b. Sanitize rendered Markdown HTML by default unless `trusted: true` is opted into.
  // Runs before splicing developer-supplied highlight/component slots so custom components remain intact.
  if (options.trusted !== true)
    html = sanitizeMarkdownHtml(html, allowedSlotPrefixes)

  // 4. Add unique heading IDs & collect TOC
  const headings: ContentHeading[] = []
  const usedIds = new Map<string, number>()

  html = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_match, levelStr: string, inner: string) => {
    const level = Number(levelStr)
    const text = stripTags(inner)
    const base = slugifyHeading(text)
    const count = usedIds.get(base) ?? 0
    usedIds.set(base, count + 1)
    const id = count === 0 ? base : `${base}-${count}`
    headings.push({ level, id, text })
    if (options.headingLinks && level >= 2 && !/<a\b/i.test(inner))
      return `<h${level} id="${id}"><a href="#${id}">${inner}</a></h${level}>`
    return `<h${level} id="${id}">${inner}</h${level}>`
  })

  // 4b. Image rewriting (explicit resolveImage or auto-wired @kayjs/images; `false` disables)
  const resolveImageFn = options.resolveImage === false
    ? undefined
    : (options.resolveImage ?? findDefaultImageResolver(options.file))
  if (resolveImageFn !== undefined) {
    html = html.replace(/<img\b([^>]*?)>/gi, (full, attrs: string) => {
      const srcMatch = /\bsrc="([^"]+)"/i.exec(attrs)
      if (!srcMatch)
        return full
      const resolved = resolveImageFn(srcMatch[1]!, options.file)
      if (!resolved)
        return full
      const info: MarkdownImageResult = typeof resolved === 'string' ? { src: resolved } : resolved
      const altMatch = /\balt="([^"]*)"/i.exec(attrs)
      const alt = altMatch ? altMatch[1]! : ''
      const parts = [`src="${escAttr(info.src)}"`, `alt="${alt}"`]
      if (info.srcset)
        parts.push(`srcset="${escAttr(info.srcset)}"`)
      if (info.sizes)
        parts.push(`sizes="${escAttr(info.sizes)}"`)
      if (info.width !== undefined && info.width > 0)
        parts.push(`width="${info.width}"`)
      if (info.height !== undefined && info.height > 0)
        parts.push(`height="${info.height}"`)
      parts.push(`loading="${info.loading ?? 'lazy'}"`, 'decoding="async"')
      const imgTag = `<img ${parts.join(' ')}>`
      if (info.avifSrcset) {
        const sizesAttr = info.sizes ? ` sizes="${escAttr(info.sizes)}"` : ''
        return `<picture><source type="image/avif" srcset="${escAttr(info.avifSrcset)}"${sizesAttr}>${imgTag}</picture>`
      }
      return imgTag
    })
  }

  // 5. Splice this batch's highlighted code blocks & embedded TSX components back in (loop handles components wrapping code fences)
  if (slots.length > 0) {
    const slotRe = new RegExp(`<div data-kay-md-slot="${slotPrefix}(\\d+)"><\\/div>`, 'g')
    let prev = ''
    while (prev !== html) {
      prev = html
      html = html.replace(slotRe, (_m, idxStr: string) => slots[Number(idxStr)] ?? '')
    }
  }

  const words = body.trim().split(/\s+/).filter(Boolean).length
  const readingMinutes = Math.max(1, Math.ceil(words / 220))
  return { html, headings, wordCount: words, readingMinutes }
}

/** Renders Markdown via Bun's native Zig `Bun.markdown.html()`, with optional Shiki `highlight`, embedded TSX `components`, heading IDs, TOC, and reading time. */
export function renderMarkdown(body: string, options: RenderMarkdownOptions = {}): {
  html: string
  headings: ContentHeading[]
  wordCount: number
  readingMinutes: number
} {
  return renderMarkdownInternal(body, options)
}
