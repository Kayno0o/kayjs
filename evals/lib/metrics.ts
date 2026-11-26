import type { RepeatedFailure, TranscriptMetrics } from './types'
import { readFileSync } from 'node:fs'

const READ_TOOLS = new Set([
  'read_file',
  'read',
  'view_file',
  'file_read',
  'cat',
  'open_file',
])

const SHELL_TOOLS = new Set([
  'run_command',
  'bash',
  'shell',
  'exec',
  'terminal',
  'command',
])

const KAY_SRC_RE = /(?:node_modules\/@kayjs\/[^/\s"'`]+|packages\/(?:kay|ui|plugin-[^/\s"'`]+))\/src\/[^\s"'`),:;]+/g
const LLMS_TXT_RE = /(?:node_modules\/@kayjs\/[^/\s"'`]+\/)?llms\.txt\b/g
const SHELL_READ_CMD_RE = /\b(?:cat|head|tail|sed|less|bat|view|src|grep|rg)\b/

const KAY_COMPILER_RE = /kay compiler:\s*([^\n]+)/g
const KAY_CHECK_ERR_RE = /kay check:\s*([^\n]+)/g
const KAY_BUILD_ERR_RE = /kay build:\s*([^\n]+)/g
const KAY_RUNTIME_RE = /kay:\s*([^\n]+)/g
const TSC_ERR_RE = /error (TS\d+):\s*([^\n]+)/g

interface NormalizedFailure {
  category: string
  sample: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function normalizeFailureMessage(raw: string): string {
  return raw
    .replace(/\b(?:\/[^\s:]+|[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+\.[a-z]+)(?::\d+:\d+)?/g, '<file>')
    .replace(/:\d+:\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

function extractFailuresFromText(text: string): NormalizedFailure[] {
  const out: NormalizedFailure[] = []
  const seenInEvent = new Set<string>()

  const push = (prefix: string, raw: string): void => {
    const sample = raw.trim().slice(0, 180)
    const category = `${prefix}: ${normalizeFailureMessage(raw)}`
    if (seenInEvent.has(category))
      return
    seenInEvent.add(category)
    out.push({ category, sample })
  }

  for (const m of text.matchAll(KAY_COMPILER_RE))
    push('kay-compiler', m[1]!)
  for (const m of text.matchAll(KAY_CHECK_ERR_RE))
    push('kay-check', m[1]!)
  for (const m of text.matchAll(KAY_BUILD_ERR_RE))
    push('kay-build', m[1]!)
  for (const m of text.matchAll(TSC_ERR_RE))
    push(`tsc-${m[1]!}`, m[2]!)

  // Match `kay: ...` runtime errors without double-counting `kay check:` / `kay build:` / `kay compiler:`
  for (const m of text.matchAll(KAY_RUNTIME_RE)) {
    const fullIdx = m.index ?? 0
    const before = text.slice(Math.max(0, fullIdx - 1), fullIdx)
    if (before !== '' && /[a-zA-Z0-9_-]/.test(before))
      continue
    push('kay-runtime', m[1]!)
  }

  return out
}

function collectPathMentions(
  text: string,
  sourceReads: string[],
  llmsReads: string[],
): void {
  for (const m of text.matchAll(KAY_SRC_RE))
    sourceReads.push(m[0])
  for (const m of text.matchAll(LLMS_TXT_RE))
    llmsReads.push(m[0])
}

function recordToolCall(
  toolName: string,
  args: unknown,
  sourceReads: string[],
  llmsReads: string[],
): void {
  const lower = toolName.toLowerCase()
  const argObj = isRecord(args) ? args : undefined

  if (READ_TOOLS.has(lower)) {
    const path = asString(argObj?.path) ?? asString(argObj?.Path) ?? asString(argObj?.file_path) ?? asString(argObj?.file) ?? asString(args)
    if (path !== undefined)
      collectPathMentions(path, sourceReads, llmsReads)
    return
  }

  if (SHELL_TOOLS.has(lower)) {
    const cmd = asString(argObj?.command) ?? asString(argObj?.CommandLine) ?? asString(argObj?.cmd) ?? asString(args)
    if (cmd !== undefined && SHELL_READ_CMD_RE.test(cmd))
      collectPathMentions(cmd, sourceReads, llmsReads)
  }
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string')
    return value
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value) {
      if (typeof item === 'string')
        parts.push(item)
      else if (isRecord(item) && typeof item.text === 'string')
        parts.push(item.text)
      else if (isRecord(item) && typeof item.content === 'string')
        parts.push(item.content)
    }
    return parts.join('\n')
  }
  if (isRecord(value))
    return JSON.stringify(value)
  return ''
}

function isGreenSignal(text: string): boolean {
  return (
    /kay check passed\b/.test(text)
    || /kay build done in\b/.test(text)
    || /"ok"\s*:\s*true/.test(text)
  )
}

function parseLines(raw: string): unknown[] {
  const trimmed = raw.trim()
  if (trimmed === '')
    return []
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed))
        return parsed
    }
    catch (err) {
      throw new Error(`evals: failed to parse JSON array transcript: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const events: unknown[] = []
  for (const line of trimmed.split('\n')) {
    const clean = line.trim()
    if (clean === '')
      continue
    try {
      events.push(JSON.parse(clean))
    }
    catch (err) {
      // Ignore non-JSON preamble lines while preserving valid JSONL entries
      if (clean.startsWith('{'))
        throw new Error(`evals: malformed JSONL transcript line: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return events
}

export function parseTranscript(raw: string): TranscriptMetrics {
  const events = parseLines(raw)

  let totalTurns = 0
  let totalToolCalls = 0
  let turnsToGreen: number | null = null
  let sawExplicitGrade = false
  let formatDetected = 'empty'

  const sourceReads: string[] = []
  const llmsReads: string[] = []
  const failureCounts = new Map<string, { count: number, sample: string }>()

  const recordFailures = (text: string): void => {
    for (const f of extractFailuresFromText(text)) {
      const prev = failureCounts.get(f.category)
      if (prev === undefined)
        failureCounts.set(f.category, { count: 1, sample: f.sample })
      else
        prev.count++
    }
  }

  for (const ev of events) {
    if (!isRecord(ev))
      continue

    const type = asString(ev.type)
    const role = asString(ev.role)
    const message = isRecord(ev.message) ? ev.message : undefined
    const msgRole = asString(message?.role)

    // 1. Normalized eval schema
    if (type === 'turn') {
      formatDetected = 'normalized'
      if (role === undefined || role === 'assistant')
        totalTurns++
      continue
    }
    if (type === 'tool_call') {
      formatDetected = 'normalized'
      totalToolCalls++
      const tool = asString(ev.tool) ?? asString(ev.name)
      if (tool !== undefined)
        recordToolCall(tool, ev.args ?? ev.input, sourceReads, llmsReads)
      continue
    }
    if (type === 'tool_result') {
      formatDetected = 'normalized'
      const text = [asString(ev.output), asString(ev.error), stringifyContent(ev.content)].filter(Boolean).join('\n')
      const failed = ev.ok === false || (typeof ev.exitCode === 'number' && ev.exitCode !== 0) || ev.is_error === true
      if (failed || text !== '')
        recordFailures(text)
      if (!failed && !sawExplicitGrade && turnsToGreen === null && totalTurns > 0 && isGreenSignal(text)) {
        const cmd = asString(ev.command) ?? ''
        if (/evals\/run\.ts\s+grade|kay\s+build/.test(cmd))
          turnsToGreen = totalTurns
      }
      continue
    }
    if (type === 'grade') {
      formatDetected = 'normalized'
      sawExplicitGrade = true
      if (ev.ok === true && turnsToGreen === null)
        turnsToGreen = Math.max(1, totalTurns)
      continue
    }

    // 2. Claude Code / Anthropic messages JSONL
    if (type === 'assistant' || msgRole === 'assistant' || role === 'assistant') {
      if (formatDetected === 'empty')
        formatDetected = message !== undefined ? 'claude-jsonl' : 'generic-jsonl'
      totalTurns++

      const content = message?.content ?? ev.content ?? ev.parts
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block))
            continue
          if (block.type === 'tool_use' && typeof block.name === 'string') {
            totalToolCalls++
            recordToolCall(block.name, block.input, sourceReads, llmsReads)
          }
          else if (isRecord(block.functionCall) && typeof block.functionCall.name === 'string') {
            totalToolCalls++
            recordToolCall(block.functionCall.name, block.functionCall.args, sourceReads, llmsReads)
          }
        }
      }

      const toolCalls = ev.toolCalls ?? ev.tool_calls
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          if (!isRecord(call))
            continue
          const name = asString(call.name) ?? asString(call.tool) ?? (isRecord(call.function) ? asString(call.function.name) : undefined)
          const args = call.args ?? call.input ?? call.arguments ?? (isRecord(call.function) ? call.function.arguments : undefined)
          if (name !== undefined) {
            totalToolCalls++
            recordToolCall(name, args, sourceReads, llmsReads)
          }
        }
      }
      continue
    }

    if (type === 'user' || msgRole === 'user' || role === 'user' || role === 'tool') {
      const content = message?.content ?? ev.content ?? ev.parts
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block))
            continue
          if (block.type === 'tool_result') {
            const text = stringifyContent(block.content)
            recordFailures(text)
            if (block.is_error !== true && !sawExplicitGrade && turnsToGreen === null && totalTurns > 0 && /kay build done in\b|evals: PASS\b/.test(text))
              turnsToGreen = totalTurns
          }
          else if (isRecord(block.functionResponse)) {
            const text = stringifyContent(block.functionResponse.response)
            recordFailures(text)
          }
        }
      }
      else {
        const text = stringifyContent(content ?? ev.output ?? ev.error)
        if (text !== '')
          recordFailures(text)
      }
    }
  }

  const repeatedFailures: RepeatedFailure[] = [...failureCounts.entries()]
    .filter(([, info]) => info.count >= 2)
    .map(([category, info]) => ({ category, count: info.count, sample: info.sample }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))

  return {
    totalTurns,
    turnsToGreen,
    sourceReads: {
      count: sourceReads.length,
      files: [...new Set(sourceReads)].sort(),
    },
    llmsReads: {
      count: llmsReads.length,
      files: [...new Set(llmsReads)].sort(),
    },
    repeatedFailures,
    totalToolCalls,
    formatDetected,
  }
}

export function parseTranscriptFile(path: string): TranscriptMetrics {
  return parseTranscript(readFileSync(path, 'utf8'))
}
