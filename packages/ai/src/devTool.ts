import type { DevTool } from 'kay/dev-tool'

// The dev tool's AI tab, a browser module kay loads on dev pages: the provider and model an ask uses, the limit and budget `ai()` set, and the asks made since the server started with their tokens, time and outcome.
const URL_PATH = '/_kay/ai'
const FRESH_MS = 2000

const TONES = { ok: 'ok', failed: 'error', stopped: 'warn', refused: 'warn' }

interface Ask {
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

interface State {
  provider?: string
  model?: string | null
  error?: string
  limit: { max: number, seconds: number } | null
  budget: { tokens: number, total: number | null, seconds: number } | null
  asks: Ask[]
}

function window(seconds: number): string {
  if (seconds % 86_400 === 0)
    return `${seconds / 86_400} d`

  if (seconds % 3600 === 0)
    return `${seconds / 3600} h`

  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`
}

export default function aiDevTool(tool: DevTool): void {
  const tab = tool.tab({ id: 'ai', label: 'AI', icon: 'puzzle', summary: count => `${count} ask${count === 1 ? '' : 's'}`, shown: show, hidden: hide })
  let asked = 0
  let timer: ReturnType<typeof setInterval> | undefined
  const sections = tool.make('div', 'stack')

  tab.panel.append(sections)

  function show(): void {
    void refresh()
    timer ??= setInterval(() => void refresh(), FRESH_MS)
  }

  function hide(): void {
    clearInterval(timer)
    timer = undefined
  }

  const say = (text: string) => sections.replaceChildren(tool.make('div', 'empty', text))
  const fact = (list: HTMLElement, name: string, value: string) => list.append(tool.make('dt', '', name), tool.make('dd', '', value))

  function draw(state: State): void {
    const facts = tool.make('dl', 'facts')

    if (state.error === undefined)
      fact(facts, 'Provider', `${state.provider} / ${state.model ?? 'no model set'}`)
    else
      facts.append(tool.make('dt', '', 'Provider'), tool.make('dd', 'error', state.error))

    fact(facts, 'Limit', state.limit === null ? 'none' : `${state.limit.max} asks per visitor every ${window(state.limit.seconds)}`)
    fact(facts, 'Budget', state.budget === null ? 'none' : `${state.budget.tokens} tokens per visitor${state.budget.total === null ? '' : `, ${state.budget.total} in all`} every ${window(state.budget.seconds)}`)

    const rows = state.asks.map((ask) => {
      const item = tool.make('div', 'row')
      const head = tool.make('div', '')
      const pill = tool.make('span', `pill ${TONES[ask.outcome]}`, ask.outcome)

      head.append(pill, ' ', tool.make('span', 'mono', `${ask.model} ${ask.tokens} tokens ${ask.ms} ms`))
      item.append(head, tool.make('div', 'note', `${new Date(ask.at).toLocaleTimeString('en-GB')} ${ask.prompt}`), ...ask.error === undefined ? [] : [tool.make('div', 'error', ask.error)])

      return item
    })

    sections.replaceChildren(tool.make('h3', 'heading', 'Setup'), facts, tool.make('h3', 'heading', 'Asks'), ...rows.length === 0 ? [tool.make('div', 'empty', 'No ask has been made since the server started.')] : rows)
    tab.count(state.asks.length)
  }

  async function refresh(): Promise<void> {
    const ask = ++asked

    try {
      const response = await fetch(URL_PATH, { cache: 'no-store' })

      if (ask !== asked)
        return

      if (response.status === 404) {
        tab.count(0)
        say('kayjs-ai lists its asks under `kay dev` alone, with ai() in the extensions.')

        return
      }

      if (!response.ok)
        throw new Error(`the server answered ${response.status}`)

      draw(await response.json() as State)
    }
    catch (error) {
      if (ask === asked)
        say(`Could not read the asks: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  void refresh()
}
