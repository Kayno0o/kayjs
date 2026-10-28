import type { Action, ActionStream, Failure } from 'kay'
import type { Attachments } from './chat-attachments'
import type { ChatMessage, ChatTurn, CodeBlock, Message, Progress, Source, ToolCall } from './types'
import { ActionError, effect, onMount, signal, untrack } from 'kay'
import { markdownReady } from 'kay/markdown'
import { filesOf, keepPending, newReplyId, pendingReply, posted, restored, shrunk, stored } from './chat-history'
import { sameSources, usableSources } from './chat-sources'
import { REPLACES_HEADER, REPLY_HEADER } from './resume'

export interface Turn extends Message {
  id: number
  // A reply the visitor stopped, or one whose stream broke off, cut where it was.
  stopped?: boolean | undefined
  // The tools the reply called, when the action streams `reply.progress()`.
  calls?: ToolCall[] | undefined
  // The reply's code blocks the server highlighted.
  code?: CodeBlock[] | undefined
  // What the model thought before answering, when the action streams `reply.progress()` and the provider sends it.
  reasoning?: string | undefined
  // Whether the visitor had its reasoning open when the reply ended.
  reasoningOpen?: boolean | undefined
}

export type ChatAction = Action<{ messages: ChatMessage[] }, AsyncIterable<string | Progress> | Failure<unknown>>

// What the session reads of the Chat, the props as getters so they stay live reads.
export interface ChatSessionOptions {
  readonly action: ChatAction
  readonly initial: readonly ChatTurn[]
  readonly keep: number
  readonly maxChars: number
  readonly remember: string | undefined
  readonly errorMessage: string
  readonly attachments: Attachments
  // The status line of a call whose status changed.
  readonly say: (call: ToolCall) => string
  // Puts the cursor back in the field.
  readonly focus: () => void
  // Takes the log back to its newest turn, as a reply starts.
  readonly follow: () => void
}

// One post: what aborts it, the id it was sent under for a Chat that remembers (what a reload resumes and a Stop ends, gone once ended), whether it said it outlives its request, so its Stop is told to the server, and whether it was asked for again after a reload, so an empty one means the server kept nothing.
interface Reply {
  abort: AbortController
  id: string | undefined
  outlives: boolean
  resumed: boolean
}

// What a regenerate or an edit replaces (`regenerate:2`), kept for Try again, which posts the same request, and the history as it stood before it cut it, put back when that post is stopped or refused before any word. Both go once a reply lands, which leaves no message for Try again.
interface Replacement {
  header: string
  before: Turn[]
}

const MAX_RETRIES = 5

// The turns of a Chat and the reply under way, which is idle, waiting (the call is out, no word yet), streaming, then ended, when what arrived joins the history. Every transition is here, apart from the DOM: the component draws it and wires its events.
export function createChatSession(options: ChatSessionOptions) {
  const { attachments } = options
  let nextId = 0
  const history = signal<Turn[]>(options.initial.map(({ sources, ...message }) => ({ ...message, ...sources && { sources: usableSources(sources) }, id: nextId++ })))
  const draft = signal('')
  const waiting = signal(false)
  const streaming = signal<ActionStream<string | Progress> | undefined>(undefined)
  // The reply so far, which becomes a turn of the history once the stream ends, with what the model thought, whether the visitor opened that, the tool calls, the code blocks the server highlighted and the documents it cites, as last seen.
  const partial = signal('')
  const thought = signal('')
  const thoughtOpen = signal(false)
  const calls = signal<ToolCall[]>([])
  const code = signal<CodeBlock[]>([])
  const found = signal<Source[]>([])
  // What the status line said of the calls, one line each and added to it, since a line replaced before the screen reader reads it is lost.
  const spoken = signal<{ id: number, text: string }[]>([])
  const failure = signal<string | undefined>(undefined)
  // The last call was refused and its message taken back, so no message waits for an answer that Try again could ask for.
  const takenBack = signal(false)
  const busy = () => waiting() || streaming() !== undefined
  const told = new Map<string, string>()
  let reply: Reply | undefined
  let replacement: Replacement | undefined
  // The last visit's turns are back, so the history may be kept.
  let recalled = false
  // The page is being left, which breaks the stream off without the reply having failed or been stopped: what it holds stays as it was, for the next visit to ask for.
  let leaving = false
  // What the action took as too long, learned from its 413s, so the app states `maxInputChars` once: the oldest turns go first, the last stays.
  let learned = Infinity

  function clearLive() {
    partial.set('')
    thought.set('')
    thoughtOpen.set(false)
    calls.set([])
    code.set([])
    found.set([])
  }

  // The reply's id is done with: no reload resumes it and no Stop ends it on the server.
  function forget(current: Reply) {
    if (options.remember !== undefined)
      keepPending(options.remember, undefined)

    current.id = undefined
  }

  // Says the calls whose status changed since the last snapshot.
  function announce(next: ToolCall[]) {
    const said: { id: number, text: string }[] = []

    for (const call of next) {
      if (told.get(call.id) === call.status)
        continue

      told.set(call.id, call.status)
      said.push({ id: nextId++, text: options.say(call) })
    }

    if (said.length > 0)
      spoken.set([...spoken(), ...said])
  }

  function show(value: string | Progress, current: Reply) {
    if (typeof value === 'string') {
      partial.set(value)

      return
    }

    if (value.outlives === true)
      current.outlives = true

    partial.set(value.text)
    thought.set(value.reasoning ?? '')
    calls.set(value.calls)
    announce(value.calls)

    if (value.sources) {
      const next = usableSources(value.sources)

      // Every snapshot of a stream repeats the list, which would redraw the reply for nothing.
      if (!sameSources(next, found()))
        found.set(next)
    }

    if (value.code)
      code.set([...code(), ...value.code])
  }

  const withDraft = (text: string) => draft.set(draft() === '' ? text : `${text}\n${draft()}`)

  // A message the schema refuses would fail every later send, and one stopped before any word came has no answer, so a next send would post two user turns: it leaves the history and goes back to the field, ahead of what the visitor typed since.
  function takeBack() {
    const last = history().at(-1)

    if (last?.role !== 'user')
      return

    const cut = replacement

    replacement = undefined
    takenBack.set(true)

    // A regenerate or an edit puts the history back as it was; an edit's text returns to the field, its files staying with the turn they came from, and a regenerate has no message to return.
    if (cut !== undefined) {
      history.set(cut.before)

      if (cut.header.startsWith('edit'))
        withDraft(last.content)

      return
    }

    history.set(history().slice(0, -1))
    withDraft(last.content)
    attachments.restore(filesOf(last))
  }

  // The reply ended on its own, was stopped or broke off: what arrived joins the history.
  function finish(state: string) {
    if (leaving)
      return

    const text = partial()
    const thinking = thought()
    const thinkingOpen = thoughtOpen()
    const made = calls()
    const highlighted = code()
    const cites = found()

    streaming.set(undefined)
    clearLive()

    // A page swap closes the stream too, leaving the reply to be asked for again when the chat returns.
    if (state !== 'closed' && reply !== undefined)
      forget(reply)

    if (state === 'done' && reply?.resumed === true && text === '' && made.length === 0)
      takeBack()

    if (text !== '' || made.length > 0) {
      replacement = undefined
      history.set([...history(), { id: nextId++, role: 'assistant', content: text, calls: made, code: highlighted, reasoning: thinking, reasoningOpen: thinkingOpen, ...cites.length > 0 && { sources: cites }, stopped: state === 'closed' }])
    }

    if (state === 'failed')
      failure.set(options.errorMessage)
    else if (state === 'closed' && text === '' && made.length === 0)
      takeBack()
  }

  // Posts the history; a 413 halves what is posted, at most 5 times a send since each counts against the action's rate limit, until the action takes it or only the last message is left.
  async function call(abort: AbortSignal, headers: Record<string, string>): Promise<ActionStream<string | Progress>> {
    for (let retries = 0; ; retries++) {
      const sent = posted(history(), options.keep, Math.min(options.maxChars, learned))

      try {
        return await options.action({ messages: sent }, { signal: abort, refresh: false, headers })
      }
      catch (error) {
        if (!(error instanceof ActionError) || error.status !== 413 || sent.length < 2 || retries === MAX_RETRIES || abort.aborted)
          throw error

        learned = shrunk(sent)
      }
    }
  }

  // A fresh send adds the visitor's message; `again` posts the history as it is, for Try again, a regenerate, an edit or a resume.
  async function post(again: boolean, question?: string, resuming?: string) {
    const text = question ?? draft().trim()
    const sent = question === undefined ? attachments.attached() : []

    if (busy() || (!again && text === '' && sent.length === 0))
      return

    // A history the server drew never loads the renderer: fetched now, it arrives while the model writes its first words.
    void markdownReady()

    if (!again) {
      replacement = undefined
      history.set([...history(), { id: nextId++, role: 'user', content: text, ...sent.length > 0 && { attachments: sent } }])

      // A suggestion leaves what the visitor was typing.
      if (question === undefined) {
        draft.set('')
        attachments.clear()
      }
    }

    // A reply is named, so a Stop ends it on the server and, for a Chat that remembers, a reload finds it.
    const current: Reply = { abort: new AbortController(), id: resuming ?? newReplyId(), outlives: false, resumed: resuming !== undefined }

    if (options.remember !== undefined && current.id !== undefined)
      keepPending(options.remember, current.id)

    reply = current
    options.follow()
    failure.set(undefined)
    takenBack.set(false)
    clearLive()
    told.clear()
    spoken.set([])
    waiting.set(true)

    try {
      // A turn that only called tools has no text to post, which a provider refuses.
      // A resume after a reload comes once the server has dropped the turns.
      const stream = await call(current.abort.signal, { [REPLY_HEADER]: `${resuming === undefined ? 'start' : 'resume'}:${current.id}`, ...resuming === undefined && replacement !== undefined && { [REPLACES_HEADER]: replacement.header } })

      if (current.abort.signal.aborted) {
        stream.close()
        takeBack()

        return
      }

      stream.on(value => show(value, current))
      streaming.set(stream)
    }
    catch (error) {
      // A call stopped before its first word is not a failure, and its message returns to the field.
      if (current.abort.signal.aborted) {
        takeBack()
      }
      else {
        console.error(error)
        forget(current)

        if (error instanceof ActionError && error.status === 422)
          takeBack()

        const refusal = error instanceof ActionError && error.status < 500 ? error.errors[''] : undefined

        failure.set(refusal !== undefined && refusal !== '' ? refusal : options.errorMessage)
      }
    }
    finally {
      waiting.set(false)
      options.focus()
    }
  }

  // Tells the server to end a reply that outlives its request, which closing the stream does not.
  async function endOnServer(id: string, messages: ChatMessage[]) {
    try {
      const answer = await options.action({ messages }, { refresh: false, headers: { [REPLY_HEADER]: `stop:${id}` } })

      if (typeof answer === 'object' && answer !== null && 'close' in answer)
        (answer as ActionStream<unknown>).close()
    }
    catch (error) {
      console.warn('the reply could not be ended on the server', error)
    }
  }

  function stop() {
    const stream = streaming()
    const current = reply
    const id = current?.id

    // A reply that showed nothing yet is ended too, as it may outlive: only one that streamed without saying so is left alone.
    if (current !== undefined && id !== undefined && busy() && (current.outlives || (partial() === '' && calls().length === 0))) {
      forget(current)
      // Only the last message goes, without its files, which any size the action takes holds.
      void endOnServer(id, posted(history(), options.keep, options.maxChars).slice(-1).map(({ role, content }) => ({ role, content })))
    }

    // Aborting a call whose answer arrived would break the body read; closing the stream is enough then.
    if (stream === undefined)
      current?.abort.abort()
    else
      stream.close()

    options.focus()
  }

  // The conversation of the tab's last visit, put back once hydrated since the server renders the initial one.
  onMount(() => {
    const key = options.remember

    if (key === undefined)
      return

    const turns = restored(key)

    recalled = true

    if (turns.length > 0)
      history.set(turns.map(turn => ({ ...turn, id: nextId++ })))

    const id = pendingReply(key)

    // A reply that was under way when the tab went is asked for again: the server finished it or goes on with it.
    if (id !== undefined && turns.at(-1)?.role === 'user')
      void post(true, undefined, id)
    else if (id !== undefined)
      keepPending(key, undefined)
  })

  effect(() => {
    const turns = history()

    // Before the last visit's turns are back, the history would overwrite them with the initial one.
    if (options.remember !== undefined && recalled)
      stored(options.remember, turns)
  })

  effect(() => {
    const stream = streaming()

    if (stream === undefined)
      return

    const state = stream.status()

    if (state !== 'open')
      untrack(() => finish(state))
  })

  return {
    history,
    draft,
    partial,
    thought,
    thoughtOpen,
    calls,
    code,
    found,
    spoken,
    failure,
    takenBack,
    busy,
    send: async (question?: string) => post(false, question),
    // Try again: the same request, the history as it is.
    retry: async () => post(true),
    stop,
    // Asks again for the last reply: it leaves the log and the history, and the post ends on the message before it, which replaces both turns on a server that keeps the conversation.
    regenerate() {
      if (busy())
        return

      replacement = { header: 'regenerate:2', before: history() }
      history.set(history().slice(0, -1))
      void post(true)
    },
    // The edited message and every turn after it leave the history, and the post ends on the new message: its files stay, and it replaces all those turns on a server that keeps the conversation. Answers why it sent nothing, `busy` while a reply is under way and `empty` for a message with no text and no file, or `missing` when the message has left the history.
    edit(id: number | undefined, text: string): 'busy' | 'empty' | 'missing' | 'sent' {
      const turns = history()
      const index = turns.findIndex(turn => turn.id === id)
      const edited = turns[index]

      if (busy())
        return 'busy'

      if (edited === undefined)
        return 'missing'

      const files = filesOf(edited)
      const content = text.trim()

      if (content === '' && files.length === 0)
        return 'empty'

      // The edit field is gone, and the edit button too while the reply is under way.
      options.focus()
      replacement = { header: `edit:${turns.length - index}`, before: turns }
      history.set([...turns.slice(0, index), { id: nextId++, role: 'user', content, ...files.length > 0 && { attachments: files } }])
      void post(true)

      return 'sent'
    },
    // Starts the conversation over: what is under way stops, and the log, the field and the kept history are cleared.
    reset() {
      stop()
      history.set([])
      replacement = undefined
      draft.set('')
      attachments.clear()
      failure.set(undefined)
      takenBack.set(false)
      clearLive()
      spoken.set([])
      told.clear()
    },
    leave() {
      leaving = true
    },
    // A stream that ended while the page was going is settled now, if the page stayed after all, such as a download or a refused leave.
    back() {
      leaving = false

      const state = streaming()?.status()

      if (state !== undefined && state !== 'open')
        finish(state)
    },
  }
}
