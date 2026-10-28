import type { Action, ActionStream, Failure, Signal } from 'kay'
import type { Attachments } from './chat-attachments'
import type { ConversationAnswer, ConversationSummary } from './conversation-title'
import type { ChatMessage, ChatTurn, CodeBlock, Message, Progress, Source, ToolCall } from './types'
import { ActionError, effect, onMount, signal, untrack } from 'kay'
import { markdownReady } from 'kay/markdown'
import { filesOf, keepPending, newReplyId, pendingReply, posted, restored, shrunk, stored } from './chat-history'
import { sameSources, usableSources } from './chat-sources'
import { renamedTitle, titleOf } from './conversation-title'
import { CONVERSATION_HEADER, CONVERSATION_ID, REPLACES_HEADER, REPLY_HEADER } from './resume'

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
  // What a Chat taking `transcribe` sends what was said through; the Chat holds the microphone, so kayjs-ui stays imported by the chat components alone.
  readonly voice?: ChatVoice | undefined
  // Where the id of a conversation held on the server is kept, the page's `conversation` query param; undefined for a Chat that holds its history itself.
  readonly conversation?: Signal<string | undefined> | undefined
  // Whether the visitor's conversations are listed, so the session reads and keeps the list.
  readonly listed?: boolean | undefined
  // Said when another tab wrote to the conversation first, when it could not be loaded, and when the visitor's session lapsed, so the conversation is no longer kept.
  readonly conflictMessage?: string | undefined
  readonly loadFailedMessage?: string | undefined
  readonly signedOutMessage?: string | undefined
}

// What a Chat's `transcribe` action answers: the text, or `{ text }`.
export type TranscribeAction = Action<{ audio: File }, string | { text: string } | Failure<unknown>>

export interface ChatVoice {
  readonly transcribe: TranscribeAction
  // What `hear` answers when `transcribe` finds no text, and when it fails.
  readonly unheardLabel: string
  readonly failedLabel: string
}

// The conversation the address names, none for a value no Chat made, which a crafted link may hold.
const named = (id: string | undefined) => id !== undefined && CONVERSATION_ID.test(id) ? id : undefined

// The one snapshot a conversation call answers with, as the JSON it holds; undefined for an answer that is no stream, or a stream that ended without one.
async function answerIn(answer: unknown): Promise<ConversationAnswer | undefined> {
  if (typeof answer !== 'object' || answer === null || !('on' in answer))
    return undefined

  const stream = answer as ActionStream<string | Progress>
  const value = await new Promise<string | Progress | undefined>((resolve) => {
    let off: (() => void) | undefined
    // A stream that ends with no value says so by its status alone, which no listener hears: kaynooo/kayjs#2574.
    const timer = setInterval(() => {
      if (stream.status() !== 'open')
        settle(stream.last())
    }, 50)

    function settle(value: string | Progress | undefined) {
      clearInterval(timer)
      off?.()
      resolve(value)
    }

    off = stream.on(settle)
  })

  stream.close()

  const text = typeof value === 'string' ? value : value?.text

  try {
    return text === undefined ? undefined : JSON.parse(text) as ConversationAnswer
  }
  catch {
    return undefined
  }
}

// One post: what aborts it, the id it was sent under for a Chat that remembers (what a reload resumes and a Stop ends, gone once ended), whether it said it outlives its request, so its Stop is told to the server, and whether it was asked for again after a reload, so an empty one means the server kept nothing.
interface Reply {
  abort: AbortController
  id: string | undefined
  outlives: boolean
  resumed: boolean
  // The conversation the reply was asked in, counted by `left`: a reply ending once the chat left it for another joins no history.
  conversation: number
  // The id it was asked under, kept once the reply is done with, as the next send names the last reply counted in the revision.
  name: string
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
  // Counts the times the chat left the conversation it showed: started over, or another one loaded. A reply or a transcription ending after it joins none.
  let left = 0

  // What was said joins the field and goes as a typed message does, with the files attached; a reply under way leaves it in the field, as post() then waits. Answers why nothing was sent, or nothing once the chat left the conversation meanwhile.
  async function hear(audio: File): Promise<string | undefined> {
    const voice = options.voice
    const heardIn = left

    if (voice === undefined)
      return undefined

    try {
      const answer = await voice.transcribe({ audio }, { refresh: false })

      if (heardIn !== left)
        return undefined

      const text = (typeof answer === 'string' ? answer : answer.text).trim()

      if (text === '')
        return voice.unheardLabel

      draft.set(draft().trim() === '' ? text : `${draft().trimEnd()} ${text}`)
      void post(false)

      return undefined
    }
    catch (error) {
      console.error(error)

      const refusal = error instanceof ActionError && error.status < 500 ? error.errors[''] : undefined

      if (heardIn !== left)
        return undefined

      return refusal === undefined || refusal === '' ? voice.failedLabel : refusal
    }
  }

  // A conversation held on the server: whether the visitor can keep one (unknown until the first answer, and false for a visitor no one names, whose history the page holds), the id whose turns the history shows, the revision they were read at, and the visitor's conversations when listed.
  const owned = signal<boolean | undefined>(undefined)
  const loading = signal(options.conversation !== undefined)
  const conversations = signal<ConversationSummary[]>([])
  let shown: string | undefined
  let revision = 0
  // The reply that last raised the revision, which the next send names for the server to check it wrote the last turn: a tab whose write lost to another sending at once raised the revision all the same. None once the conversation is read, as its revision then comes from the store.
  let counted: string | undefined
  let mounted = false
  // Counts the loads, so only the latest one shows, and names the conversation the last one asked for, so the address naming it loads it once.
  let loads = 0
  let asked = options.conversation === undefined ? undefined : named(untrack(options.conversation))
  const holding = () => options.conversation !== undefined && owned() !== false

  // A read or a change of the conversations, which the action answers through `ask` with no model asked: the message only carries a rename's title.
  async function consult(header: string, content = ''): Promise<ConversationAnswer | undefined> {
    return answerIn(await options.action({ messages: [{ role: 'user', content }] }, { refresh: false, headers: { [CONVERSATION_HEADER]: header } }))
  }

  // Shows the conversation `id`, or a new one; a visitor the server cannot keep one for gets the tab's history back, as without `keepOnServer`.
  // `resume` is false once a resume came back empty, so a reply the server still names but no longer keeps is not asked for again and again.
  async function load(id: string | undefined, resume = true) {
    const turn = ++loads
    let replying: string | undefined

    asked = id
    left++
    loading.set(true)
    failure.set(undefined)

    try {
      const answer = await consult(id === undefined ? 'load' : `load:${id}`)

      if (turn !== loads)
        return

      if (answer?.owned === false) {
        const lapsed = owned() === true

        owned.set(false)

        // A session that lapsed leaves the conversation shown, which the next send posts whole, as a Chat holding its own history does.
        if (lapsed) {
          failure.set(options.signedOutMessage ?? options.errorMessage)

          return
        }

        // A guest whose first send was refused, its ownership unknown, has nothing changed in another tab to be told of.
        failure.set(undefined)
        recall()

        return
      }

      if (answer?.owned !== true || answer.op !== 'load')
        throw new Error('the action answered no conversation; it returns the reply of ask() as it is')

      owned.set(true)
      shown = answer.id
      revision = answer.revision
      counted = undefined
      replacement = undefined
      replying = answer.replying

      // A reply not asked for again leaves out the message the server shows ahead of it, which is back in the field.
      const stored = resume || replying === undefined ? answer.turns : answer.turns.slice(0, -1)

      history.set(stored.map(({ sources, ...turn }) => ({ ...turn, ...sources && { sources: usableSources(sources) }, id: nextId++ })))
    }
    catch (error) {
      if (turn !== loads)
        return

      console.error(error)
      failure.set(options.loadFailedMessage ?? options.errorMessage)
    }
    finally {
      if (turn === loads)
        loading.set(false)
    }

    // A reply still running on the server past its request, as after a reload, is asked for again as `remember` does.
    if (resume && replying !== undefined && turn === loads)
      void post(true, undefined, replying)
  }

  async function list() {
    try {
      const answer = await consult('list')

      if (answer?.owned === true && answer.op === 'list')
        conversations.set(answer.conversations)
      else if (answer?.owned === false)
        owned.set(false)
    }
    catch (error) {
      console.error(error)
    }
  }

  // The conversation shown moves to the top of the list once a reply landed in it, under the opening words of its first message when it is new.
  function touched() {
    if (!options.listed || shown === undefined)
      return

    const id = shown
    const known = conversations().find(item => item.id === id)
    const first = history().find(({ role }) => role === 'user')

    conversations.set([{ id, title: known?.title ?? titleOf(first?.content ?? ''), updatedAt: Date.now() }, ...conversations().filter(item => item.id !== id)])
  }

  // A new conversation: nothing is stored until its first reply lands.
  function startNew() {
    left++
    shown = undefined
    revision = 0
    counted = undefined
    replacement = undefined
    history.set([])
  }

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

    // A reply stopped as the chat left its conversation belongs to none shown, and the server stored it in its own.
    if (reply !== undefined && reply.conversation !== left) {
      forget(reply)

      return
    }

    // A page swap closes the stream too, leaving the reply to be asked for again when the chat returns.
    if (state !== 'closed' && reply !== undefined)
      forget(reply)

    // A resume that brought nothing back put the message back in the field; on the server it stored nothing, or the process lost the reply, so the conversation is read again.
    if (state === 'done' && reply?.resumed === true && text === '' && made.length === 0) {
      takeBack()

      if (holding())
        void load(shown, false)
    }

    if (text !== '' || made.length > 0) {
      replacement = undefined
      history.set([...history(), { id: nextId++, role: 'assistant', content: text, calls: made, code: highlighted, reasoning: thinking, reasoningOpen: thinkingOpen, ...cites.length > 0 && { sources: cites }, stopped: state === 'closed' }])
    }

    // The server stored the exchange as it does: a reply that ended, or one stopped or broken off once it had said or called something, a reply resumed after a reload included.
    const held = holding()

    if (held && (text !== '' || made.length > 0 || (state === 'done' && reply?.resumed !== true))) {
      revision++
      counted = reply?.name
      touched()
    }

    // A conversation held on the server stored nothing of a reply that failed before its first word, so its message goes back to the field, keeping the turns the chat shows in line with the stored ones.
    if (held && state === 'failed' && text === '' && made.length === 0)
      takeBack()

    if (state === 'failed')
      failure.set(options.errorMessage)
    else if (state === 'closed' && text === '' && made.length === 0)
      takeBack()
  }

  // Posts the history; a 413 halves what is posted, at most 5 times a send since each counts against the action's rate limit, until the action takes it or only the last message is left.
  // A conversation held on the server is posted its last message alone.
  async function call(abort: AbortSignal, headers: Record<string, string>): Promise<ActionStream<string | Progress>> {
    for (let retries = 0; ; retries++) {
      const sent = posted(history(), headers[CONVERSATION_HEADER] === undefined ? options.keep : 1, Math.min(options.maxChars, learned))

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

    if (busy() || loading() || (!again && text === '' && sent.length === 0))
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

    const held = holding()

    // A new conversation is named by its first send, and the page's address keeps the name, so a reload or Back finds it.
    if (held && shown === undefined) {
      shown = newReplyId()
      options.conversation?.set(shown)
    }

    // A reply is named, so a Stop ends it on the server and, for a Chat that remembers its history in the tab, a reload finds it.
    const name = resuming ?? newReplyId()
    const current: Reply = { abort: new AbortController(), id: name, name, outlives: false, resumed: resuming !== undefined, conversation: left }

    if (options.remember !== undefined && !held && current.id !== undefined)
      keepPending(options.remember, current.id)

    reply = current
    options.follow()

    // A resume after a conflict keeps saying the conversation changed.
    if (resuming === undefined)
      failure.set(undefined)

    takenBack.set(false)
    clearLive()
    told.clear()
    spoken.set([])
    waiting.set(true)

    try {
      // A turn that only called tools has no text to post, which a provider refuses.
      // A resume after a reload comes once the server has dropped the turns.
      const stream = await call(current.abort.signal, { [REPLY_HEADER]: `${resuming === undefined ? 'start' : 'resume'}:${current.id}`, ...resuming === undefined && replacement !== undefined && { [REPLACES_HEADER]: replacement.header }, ...held && { [CONVERSATION_HEADER]: `send:${shown}:${revision}${counted === undefined ? '' : `:${counted}`}` } })

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

        // Another tab wrote to the conversation first: the message goes back to the field and the conversation is read again.
        if (held && error instanceof ActionError && error.status === 409) {
          takeBack()
          void load(shown)
          failure.set(options.conflictMessage ?? options.errorMessage)

          return
        }

        // A conversation held on the server stored nothing of a refused call either.
        if (held || (error instanceof ActionError && error.status === 422))
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

  // A conversation held on the server is read once hydrated, and again when the address names another one, by a link of the list or Back.
  onMount(() => {
    mounted = true

    if (options.conversation === undefined) {
      recall()

      return
    }

    void load(named(untrack(options.conversation)))

    if (options.listed)
      void list()
  })

  effect(() => {
    const id = named(options.conversation?.())

    untrack(() => {
      if (!mounted || id === shown || (loading() && id === asked) || owned() === false)
        return

      if (busy())
        stop()

      if (id === undefined)
        startNew()
      else
        void load(id)
    })
  })

  // The conversation of the tab's last visit, put back once hydrated since the server renders the initial one.
  function recall() {
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
  }

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
    hear,
    owned,
    loading,
    // A conversation the address names is being read: the empty chat's greeting waits for it, while a new one shows it at once.
    opening: () => loading() && asked !== undefined,
    conversations,
    // Renames a listed conversation, the list showing the title once the server took it; answers whether it did, and throws when the call failed.
    async rename(id: string, title: string): Promise<boolean> {
      const answer = await consult(`rename:${id}`, title)
      const done = answer?.owned === true && answer.op === 'rename' && answer.done

      if (done)
        conversations.set(conversations().map(item => item.id === id ? { ...item, title: renamedTitle(title) } : item))

      return done
    },
    // Deletes a conversation for good; the one shown leaves the chat empty for a new one.
    async remove(id: string): Promise<boolean> {
      const answer = await consult(`remove:${id}`)
      const done = answer?.owned === true && answer.op === 'remove'

      if (done)
        conversations.set(conversations().filter(item => item.id !== id))

      if (done && id === shown) {
        if (busy())
          stop()

        startNew()
        options.conversation?.set(undefined)
      }

      return done
    },
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
      left++
      history.set([])
      replacement = undefined

      // A conversation held on the server stays stored, and the address names none until the next send.
      if (shown !== undefined) {
        startNew()
        options.conversation?.set(undefined)
      }

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
