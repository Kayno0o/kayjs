import type { Action } from 'kay'
import type { ToolAction, ToolCall } from '../../src'

export interface Outcome {
  text: string
  calls: ToolCall[]
  finish: string | undefined
  usage: { inputTokens: number, outputTokens: number } | undefined
}

export interface Step {
  text: string
  calls: ToolCall[]
}

// The actions of the fixture's tools page, as the tests reach them.
export interface Tools {
  converse: ToolAction & Action<{ prompt: string, maxSteps?: number, offer?: string[] }, Outcome>
  watch: Action<{ prompt: string }, Step[]>
}
