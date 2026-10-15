// A line bun test writes between one test's output and the next: a result, or a file's header, as a parallel run prints it locally and CI groups it.
const BOUNDARY = /^(?:\((?:pass|fail|skip|todo)\) |::(?:end)?group::|\S+\.test\.[jt]sx?:$)/
const DURATION = / \[[\d.]+m?s\]$/
const FAIL = '(fail) '
const MAX = 10

// Each failed test's own output, from the line after the previous boundary down to its `(fail)` line, once per test as bun test lists them again by name at the end.
export function failedTests(lines: string[]): string[] {
  const seen = new Set<string>()
  const blocks: string[] = []

  for (const [index, line] of lines.entries()) {
    const name = line.replace(DURATION, '')

    if (!line.startsWith(FAIL) || seen.has(name))
      continue

    seen.add(name)

    if (blocks.length < MAX)
      blocks.push(lines.slice(lines.findLastIndex((text, at) => at < index && BOUNDARY.test(text)) + 1, index + 1).filter(text => !text.startsWith('::')).join('\n').trim())
  }

  if (seen.size > MAX)
    blocks.push(`and ${seen.size - MAX} more failed tests`)

  return blocks
}
