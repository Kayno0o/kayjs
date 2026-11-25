// YAML frontmatter parsing (via Bun.YAML) and source line lookup for diagnostics.

/** Parses full nested YAML frontmatter using Bun's native Zig `Bun.YAML.parse`. */
export function parseFrontmatter(source: string): { data: Record<string, unknown>, body: string } {
  const normalized = source.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n'))
    return { data: {}, body: normalized }

  const end = normalized.indexOf('\n---', 4)
  if (end === -1)
    return { data: {}, body: normalized }

  const rawYaml = normalized.slice(4, end)
  const restStart = normalized.indexOf('\n', end + 4)
  const body = restStart === -1 ? '' : normalized.slice(restStart + 1)

  const parsed = rawYaml.trim() === '' ? {} : Bun.YAML.parse(rawYaml)
  const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
  return { data, body }
}

/** Finds the 1-based line number of a top-level frontmatter key for `kay check` diagnostics. */
export function findFrontmatterFieldLine(rawSource: string, fieldPath: string | undefined): number {
  const normalized = rawSource.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n'))
    return 1
  const end = normalized.indexOf('\n---', 4)
  if (end === -1)
    return 1
  if (!fieldPath)
    return 2
  const topKey = fieldPath.split('.')[0] ?? fieldPath
  const escaped = topKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const keyRe = new RegExp(`^\\s*${escaped}\\s*:`)
  const lines = normalized.slice(4, end).split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (keyRe.test(lines[i]!))
      return i + 2
  }
  return 2
}
