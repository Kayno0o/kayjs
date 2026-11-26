// Output pruning, compact text/TSV formatting, truncation, and Response normalization for @kayjs/mcp.

export interface McpContentBlock {
  type: 'text'
  text: string
}

export interface McpToolResult {
  content: McpContentBlock[]
  isError?: boolean | undefined
}

export type McpPruneMode = false | 'nullish' | true

export interface PruneEmptyOptions {
  /** Also drop empty arrays `[]` and empty objects `{}` (default: true). */
  emptyCollections?: boolean | undefined
  /** Also drop empty strings `""` (default: false). */
  emptyStrings?: boolean | undefined
}

export interface CompactListOptions {
  /** Total available items when the returned slice is paginated. */
  total?: number | undefined
  /** Next cursor/offset hint shown in the footer when more items exist. */
  nextCursor?: string | number | null | undefined
  /** Fallback text when the list is empty (default: '(none)'). */
  empty?: string | undefined
}

/** Recursively removes `null`/`undefined` (and by default empty `[]`/`{}`) to shrink JSON payloads. */
export function pruneEmpty(value: unknown, options?: PruneEmptyOptions): unknown {
  const dropCollections = options?.emptyCollections ?? true
  const dropStrings = options?.emptyStrings ?? false
  const ancestors = new Set<object>()

  function walk(node: unknown, isRoot: boolean): unknown {
    if (node === null || node === undefined)
      return isRoot ? node : undefined
    if (typeof node === 'string')
      return !isRoot && dropStrings && node.length === 0 ? undefined : node
    if (Array.isArray(node)) {
      if (ancestors.has(node))
        return undefined
      ancestors.add(node)
      try {
        const out: unknown[] = []
        for (const item of node) {
          const cleaned = walk(item, false)
          if (cleaned !== undefined)
            out.push(cleaned)
        }
        if (!isRoot && dropCollections && out.length === 0)
          return undefined
        return out
      }
      finally {
        ancestors.delete(node)
      }
    }
    if (typeof node === 'object') {
      const proto = Object.getPrototypeOf(node)
      if (proto !== Object.prototype && proto !== null)
        return node
      if (ancestors.has(node))
        return undefined
      ancestors.add(node)
      try {
        const out: Record<string, unknown> = {}
        let count = 0
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          const cleaned = walk(v, false)
          if (cleaned !== undefined) {
            out[k] = cleaned
            count++
          }
        }
        if (!isRoot && dropCollections && count === 0)
          return undefined
        return out
      }
      finally {
        ancestors.delete(node)
      }
    }
    return node
  }

  return walk(value, true)
}

function formatListFooter(count: number, options?: CompactListOptions): string {
  const parts: string[] = []
  if (options?.total !== undefined && options.total > count)
    parts.push(`${count}/${options.total}`)
  if (options?.nextCursor !== undefined && options.nextCursor !== null && String(options.nextCursor).length > 0)
    parts.push(`next=${options.nextCursor}`)
  return parts.length > 0 ? `\n--- ${parts.join(', ')}` : ''
}

/** Renders items as compact one-line-per-entry text with an optional pagination footer. */
export function formatLines<T>(
  items: readonly T[],
  render: (item: T, index: number) => string,
  options?: CompactListOptions,
): string {
  if (items.length === 0)
    return options?.empty ?? '(none)'
  return items.map(render).join('\n') + formatListFooter(items.length, options)
}

function escapeTsvCell(value: unknown): string {
  if (value === null || value === undefined)
    return ''
  const raw = typeof value === 'string'
    ? value
    : (typeof value === 'object' ? JSON.stringify(value) : String(value))
  return raw.replace(/[\t\r\n]+/g, ' ')
}

/** Renders tabular records as compact TSV (typically 50–65% fewer tokens than JSON object arrays). */
export function formatTable<T extends Record<string, unknown>>(
  rows: readonly T[],
  columns?: readonly (keyof T & string)[],
  options?: CompactListOptions,
): string {
  if (rows.length === 0)
    return options?.empty ?? '(none)'
  const cols: readonly string[] = columns && columns.length > 0
    ? columns
    : Object.keys(rows[0] ?? {})
  if (cols.length === 0)
    return options?.empty ?? '(none)'

  const lines: string[] = [cols.join('\t')]
  for (const row of rows)
    lines.push(cols.map(col => escapeTsvCell(row[col])).join('\t'))
  return lines.join('\n') + formatListFooter(rows.length, options)
}

/** Truncates oversized text outputs cleanly while leaving an actionable recovery hint. */
export function truncateOutput(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars)
    return text
  const reserve = 64
  if (maxChars <= reserve)
    return text.slice(0, maxChars)
  let keep = maxChars - reserve
  let omitted = text.length - keep
  let suffix = `\n…[truncated ${omitted} chars — narrow query or paginate]`
  if (keep + suffix.length > maxChars) {
    keep = Math.max(0, maxChars - suffix.length)
    omitted = text.length - keep
    suffix = `\n…[truncated ${omitted} chars — narrow query or paginate]`
  }
  return text.slice(0, keep) + suffix
}

export function applyPrune(value: unknown, mode: McpPruneMode): unknown {
  if (mode === false)
    return value
  if (mode === 'nullish')
    return pruneEmpty(value, { emptyCollections: false })
  return pruneEmpty(value, { emptyCollections: true })
}

export function isMcpToolResult(value: unknown): value is McpToolResult {
  if (typeof value !== 'object' || value === null || !('content' in value))
    return false
  const content = (value as { content: unknown }).content
  return Array.isArray(content) && content.every(
    item => typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'text' && typeof (item as { text?: unknown }).text === 'string',
  )
}

export function formatFieldErrors(fieldErrors: unknown): string {
  if (fieldErrors === null || typeof fieldErrors !== 'object' || Array.isArray(fieldErrors))
    return ''
  return Object.entries(fieldErrors as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && String(v).length > 0)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join('; ')
}

export async function formatResponseResult(res: Response, pruneMode: McpPruneMode): Promise<McpToolResult> {
  // 3xx redirects from reused Kay form actions indicate a completed mutation, not a failure.
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location')
    return { content: [{ type: 'text', text: location ? `ok -> ${location}` : 'ok' }] }
  }

  const rawText = await res.text()
  if (!res.ok) {
    let errorMsg = rawText || `${res.status} ${res.statusText}`.trim()
    if (rawText.trimStart().startsWith('{')) {
      try {
        const parsed = JSON.parse(rawText) as { error?: unknown, message?: unknown, fieldErrors?: unknown }
        const base = typeof parsed.error === 'string' && parsed.error.length > 0
          ? parsed.error
          : (typeof parsed.message === 'string' && parsed.message.length > 0 ? parsed.message : '')
        const fields = formatFieldErrors(parsed.fieldErrors)
        if (base && fields)
          errorMsg = `${base} (${fields})`
        else if (base)
          errorMsg = base
        else if (fields)
          errorMsg = fields
      }
      catch {
        // Keep rawText
      }
    }
    return { content: [{ type: 'text', text: errorMsg }], isError: true }
  }

  if (rawText.length === 0 && res.status === 204)
    return { content: [{ type: 'text', text: 'ok' }] }

  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('json')) {
    try {
      const parsed = JSON.parse(rawText) as unknown
      return { content: [{ type: 'text', text: JSON.stringify(applyPrune(parsed, pruneMode)) }] }
    }
    catch {
      // Keep rawText when body is not valid JSON
    }
  }
  return { content: [{ type: 'text', text: rawText }] }
}

export function applyOutputBudget(result: McpToolResult, maxChars: number | undefined): McpToolResult {
  if (maxChars === undefined || maxChars <= 0)
    return result
  let remaining = maxChars
  const nextContent: McpContentBlock[] = []
  for (const block of result.content) {
    if (remaining <= 0)
      break
    const text = truncateOutput(block.text, remaining)
    remaining -= text.length
    nextContent.push({ type: 'text', text })
  }
  return result.isError !== undefined
    ? { content: nextContent, isError: result.isError }
    : { content: nextContent }
}

export async function finalizeToolValue(value: unknown, pruneMode: McpPruneMode): Promise<McpToolResult> {
  if (value instanceof Response)
    return await formatResponseResult(value, pruneMode)
  if (isMcpToolResult(value))
    return value
  if (typeof value === 'string')
    return { content: [{ type: 'text', text: value }] }
  if (value === undefined)
    return { content: [{ type: 'text', text: 'ok' }] }
  return { content: [{ type: 'text', text: JSON.stringify(applyPrune(value, pruneMode)) }] }
}
