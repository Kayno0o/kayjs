import type { Action } from 'kay'
import type { DeepPartial, ToolCall } from '../../src'

export interface Verdict {
  title: string
  score: number
  tags: string[]
  author: { name: string }
}

// The actions of the fixture's verdicts page: the streaming ones answer the snapshots, the one resolving the reply first its whole value.
export interface Verdicts {
  summarize: Action<{ prompt: string }, DeepPartial<Verdict>[]>
  triage: Action<{ prompt: string }, DeepPartial<Verdict>[]>
  whole: Action<{ prompt: string }, Verdict>
  outcome: Action<{ prompt: string, maxSteps?: number }, { value: Verdict, calls: ToolCall[], finish: string | undefined, usage: { inputTokens: number, outputTokens: number } | undefined }>
}
