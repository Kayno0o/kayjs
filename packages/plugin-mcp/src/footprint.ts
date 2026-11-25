// Up-front tools/list byte & token footprint measurement, budget enforcement, and CLI table formatting.

import type { JsonSchemaObject } from './schema'

export const DEFAULT_MAX_TOOL_BYTES = 2048

export interface McpBudgetOptions {
  /** Per-tool byte budget in `tools/list` (default: 2048). */
  maxToolBytes?: number | undefined
  /** Total `instructions` + `tools/list` byte budget (optional). */
  maxTotalBytes?: number | undefined
  /** When true, `kay check` fails with `ctx.error()` on budget overruns instead of warning (default: false). */
  strict?: boolean | undefined
  /** Custom warning sink for dev startup / non-strict `kay check` (default: `console.warn`). */
  onWarn?: ((message: string) => void) | undefined
}

export interface McpToolFootprint {
  name: string
  chars: number
  bytes: number
  descriptionBytes: number
  schemaBytes: number
  estimatedTokens: number
}

export interface McpFootprint {
  instructionsChars: number
  instructionsBytes: number
  toolsChars: number
  toolsBytes: number
  totalChars: number
  totalBytes: number
  estimatedTokens: number
  tools: McpToolFootprint[]
}

export interface ListedToolShape {
  name: string
  description: string
  inputSchema: JsonSchemaObject
}

function utf8Bytes(str: string): number {
  return Buffer.byteLength(str, 'utf8')
}

export function computeFootprint(instructions: string | undefined, listedTools: readonly ListedToolShape[]): McpFootprint {
  const instructionsText = instructions ?? ''
  const instructionsChars = instructionsText.length
  const instructionsBytes = utf8Bytes(instructionsText)
  const tools: McpToolFootprint[] = []
  let toolsChars = 0
  let toolsBytes = 0

  for (const listed of listedTools) {
    const json = JSON.stringify(listed)
    const chars = json.length
    const bytes = utf8Bytes(json)
    const descriptionBytes = utf8Bytes(listed.description)
    const schemaBytes = utf8Bytes(JSON.stringify(listed.inputSchema))
    toolsChars += chars
    toolsBytes += bytes
    tools.push({
      name: listed.name,
      chars,
      bytes,
      descriptionBytes,
      schemaBytes,
      estimatedTokens: Math.ceil(bytes / 4),
    })
  }

  tools.sort((a, b) => b.bytes - a.bytes)
  const totalChars = instructionsChars + toolsChars
  const totalBytes = instructionsBytes + toolsBytes
  return {
    instructionsChars,
    instructionsBytes,
    toolsChars,
    toolsBytes,
    totalChars,
    totalBytes,
    estimatedTokens: Math.ceil(totalBytes / 4),
    tools,
  }
}

export function collectBudgetViolations(footprint: McpFootprint, budget: McpBudgetOptions | false | undefined): string[] {
  if (budget === false)
    return []
  const maxToolBytes = budget?.maxToolBytes ?? DEFAULT_MAX_TOOL_BYTES
  const maxTotalBytes = budget?.maxTotalBytes
  const violations: string[] = []

  if (maxToolBytes > 0) {
    for (const tool of footprint.tools) {
      if (tool.bytes > maxToolBytes) {
        violations.push(
          `[@kayjs/mcp] tool "${tool.name}" is ${tool.bytes} B (~${tool.estimatedTokens} tok; desc ${tool.descriptionBytes} B, schema ${tool.schemaBytes} B), exceeding ${maxToolBytes} B budget`,
        )
      }
    }
  }
  if (maxTotalBytes !== undefined && maxTotalBytes > 0 && footprint.totalBytes > maxTotalBytes) {
    violations.push(
      `[@kayjs/mcp] total MCP surface is ${footprint.totalBytes} B (~${footprint.estimatedTokens} tok), exceeding ${maxTotalBytes} B budget`,
    )
  }
  return violations
}

/** Formats an `McpFootprint` report as a compact table for CLI / CI output. */
export function formatMcpFootprint(footprint: McpFootprint, budget?: McpBudgetOptions | false): string {
  const maxToolBytes = budget === false ? undefined : (budget?.maxToolBytes ?? DEFAULT_MAX_TOOL_BYTES)
  const lines = [
    `@kayjs/mcp footprint: ${footprint.totalBytes} B (~${footprint.estimatedTokens} tok) — instructions: ${footprint.instructionsBytes} B, tools: ${footprint.toolsBytes} B (${footprint.tools.length} tools)`,
  ]
  const nameWidth = footprint.tools.reduce((max, t) => Math.max(max, t.name.length), 0)
  for (const t of footprint.tools) {
    const flag = maxToolBytes !== undefined && maxToolBytes > 0 && t.bytes > maxToolBytes
      ? `  [OVER ${maxToolBytes} B]`
      : ''
    lines.push(
      `  ${t.name.padEnd(nameWidth)}  ${String(t.bytes).padStart(6)} B (~${t.estimatedTokens} tok)  desc: ${t.descriptionBytes} B  schema: ${t.schemaBytes} B${flag}`,
    )
  }
  return lines.join('\n')
}
