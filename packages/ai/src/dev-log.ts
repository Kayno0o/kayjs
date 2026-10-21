import type { Piece, Usage } from './types'
import { underKayDev } from 'kay/library'
import { AiError } from './errors'
import { tokensUsed } from './limits'

const SLOT = Symbol.for('kayjs-ai.dev-log')
const KEPT = 50
const PROMPT_CHARS = 160

export interface AskRecord {
  id: number
  at: string
  provider: string
  model: string
  prompt: string
  tokens: number
  ms: number
  outcome: 'ok' | 'failed' | 'stopped' | 'refused'
  error?: string | undefined
}

interface Slot {
  records: AskRecord[]
  next: number
}

// On the global, so every copy of the library in the process shares the asks the dev tool lists.
function slot(): Slot {
  const holder = globalThis as { [SLOT]?: Slot }

  return holder[SLOT] ??= { records: [], next: 1 }
}

// The asks made since the server started, newest last, the last 50 only.
export function recordedAsks(): AskRecord[] {
  return slot().records
}

export function forgetAsks(): void {
  slot().records = []
}

// Passes the pieces through and, under `kay dev` alone, keeps how the ask went for the dev tool's tab, whether it finished, failed, was refused by a limit or stopped.
export async function* recorded(pieces: AsyncIterable<Piece>, about: { provider: string, model: string, prompt: string, chars: number }, signal: AbortSignal): AsyncGenerator<Piece> {
  if (!underKayDev()) {
    yield* pieces

    return
  }

  const started = performance.now()
  const usage: Partial<Usage> = {}
  let received = 0
  let outcome: AskRecord['outcome'] = 'ok'
  let error: string | undefined

  try {
    for await (const piece of pieces) {
      if ('text' in piece)
        received += piece.text.length
      else if ('usage' in piece)
        Object.assign(usage, piece.usage)

      yield piece
    }
  }
  catch (thrown) {
    outcome = thrown instanceof AiError && thrown.kind === 'limited' ? 'refused' : 'failed'
    error = thrown instanceof Error ? thrown.message : String(thrown)

    throw thrown
  }
  finally {
    const kept = slot()
    const { records } = kept

    if (outcome === 'ok' && signal.aborted)
      outcome = 'stopped'

    records.push({
      id: kept.next++,
      at: new Date().toISOString(),
      provider: about.provider,
      model: about.model,
      prompt: about.prompt.slice(0, PROMPT_CHARS),
      tokens: outcome === 'refused' ? 0 : tokensUsed(usage, about.chars, received, signal.aborted),
      ms: Math.round(performance.now() - started),
      outcome,
      error,
    })

    if (records.length > KEPT)
      records.splice(0, records.length - KEPT)
  }
}
