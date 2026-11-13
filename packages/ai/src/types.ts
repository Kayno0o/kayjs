import type { Action, Duration, Schema, Static } from 'kay'
import type { IconProps } from 'kay/icons'
import type { BeforeHook, ByteSize, Hook } from 'kay/library'
import type { StoredFile } from './attachments'
import type { AiErrorKind } from './errors'

// The round buttons of a `Chat` an app draws its own icon on, by `icons`.
export type ChatIconName = 'send' | 'stop' | 'new' | 'attach' | 'regenerate' | 'edit' | 'record'

// An icon of the app's settings, by its slot name, or one imported from `~icons/<prefix>/<name>`, as kayjs-ui's `Icon` takes it.
export type ChatIconValue = IconProps | (string & {})

// The icons a `Chat` draws in place of its own, by button; a name left out keeps the default.
export type ChatIcons = Partial<Record<ChatIconName, ChatIconValue>>

// A `ChatLauncher` adds the icons of its button and its panel's header.
export type ChatLauncherIcons = ChatIcons & Partial<Record<'open' | 'close' | 'expand' | 'collapse', ChatIconValue>>

// A file the model is shown: bytes or a `Blob` (a `File` from an `s.File()` field is one), or a file kay stored (`storedFile(key)`, never a key a visitor chose). What it is comes from its bytes, not its name or declared type: a PNG, JPEG, GIF or WebP image, or a PDF.
export type AiAttachment = Blob | Uint8Array | ArrayBuffer | StoredFile

// A message as `Chat` posts it to its action: the files a visitor attached are `File`s, which a schema takes as `attachments: s.Optional(s.Array(s.File({ ... })))`.
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  attachments?: File[]
}

// An attachment as a provider is sent it: read, its kind found from its bytes.
export interface Media {
  kind: 'image' | 'pdf'
  // `image/png`, `image/jpeg`, `image/gif`, `image/webp` or `application/pdf`.
  type: string
  data: Uint8Array
  // The file's name when it had one.
  name?: string | undefined
}

// A document a reply cites as `[n]`: a `Chat` links each `[n]` outside code to `href` and lists the cited ones, by `title`, under the turn.
export interface Source {
  n: number
  title: string
  href: string
}

export interface AiMessage {
  // `system` is not a role here: the prompt that frames the reply goes in `options.system`, so a history posted by a visitor cannot carry one.
  role: 'user' | 'assistant'
  content: string
  // What an assistant message cites, for a `Chat`'s `initial` to show again; `ask` leaves it out of the request.
  sources?: readonly Source[] | undefined
  // Images and PDFs shown to the model beside the text, on a user message; they count toward `maxInputChars` as `ask` estimates and each is under `maxSize`.
  attachments?: readonly AiAttachment[] | undefined
}

// A message a `Chat` shows to start with, through `initial`: an island prop carries no `Blob`, so it has no attachments.
export type ChatTurn = Pick<AiMessage, 'role' | 'content' | 'sources'>

// A turn as `Chat`'s `@turn` and `@actions` blocks receive it: plain data, the turn being written included (`pending`).
export interface ChatTurnView extends ChatTurn {
  // The tools the reply called, when the action streams `reply.progress()`.
  calls: readonly AiToolCall[]
  // A reply the visitor stopped, or one whose stream broke off.
  stopped: boolean
  // The reply still streaming in, whose `content` grows.
  pending: boolean
}

// What `Chat`'s `onError` receives: the message the chat shows, the refused call's HTTP status when the action answered one (a stream that broke off has none), and what the call threw.
export interface ChatFailure {
  message: string
  status: number | undefined
  error?: unknown
}

export interface Usage {
  // The input read at full price: what the provider did not take from its cache, nor write to it.
  inputTokens: number
  outputTokens: number
  // Input tokens read from the provider's prompt cache, and written to it (Anthropic bills the write above a plain token); absent when the provider reported none.
  cacheReadTokens?: number | undefined
  cacheWriteTokens?: number | undefined
}

// What the model is told of a tool it may call.
export interface ToolSpec {
  name: string
  description: string
  inputSchema: object
}

// A call the model made, its arguments as the raw text it wrote, which may not be JSON.
export interface ToolUse {
  id: string
  name: string
  arguments: string
}

// What a call gave back to the model; not `ok` when it was refused, failed or could not be understood, `content` then saying why in words the model can correct from.
export interface ToolOutcome {
  id: string
  content: string
  ok: boolean
}

// A finished block of the model's thinking: the text with the signature that proves it, or the encrypted block Anthropic sends in its place (`redacted`).
export type Thinking = { text: string, signature: string } | { redacted: string }

// A message as a provider is sent it: the assistant's turn that called tools carries `calls`, and the turn answering them, from the user's side, `results`.
export interface ProviderMessage extends Omit<AiMessage, 'attachments'> {
  // The thinking that came before the calls, which Anthropic requires back unchanged in the turn that called tools.
  thinking?: Thinking[] | undefined
  // The `provider/model` that thought it: a signature binds the block to that model, so a request to another one leaves `thinking` out. Absent, the blocks are sent to whichever answers.
  thinkingBy?: string | undefined
  attachments?: Media[] | undefined
  calls?: ToolUse[] | undefined
  results?: ToolOutcome[] | undefined
}

// How much a reasoning model thinks before it answers.
export type Reasoning = 'none' | 'low' | 'medium' | 'high'

// What a provider is asked for, the model and the limits already settled.
export interface ProviderRequest {
  messages: ProviderMessage[]
  tools?: ToolSpec[] | undefined
  system: string | undefined
  model: string
  maxTokens: number
  temperature: number | undefined
  reasoning?: Reasoning | undefined
  // JSON Schema of the object the reply is: the provider asks the model for it its own way and streams the JSON as text, which `ask` reads and checks against the kay schema.
  schema?: object | undefined
  // Whether to ask the provider to cache the prompt: on when absent, `'1h'` for Anthropic's 1 hour lifetime.
  cache?: boolean | '1h' | undefined
  // Fields to add to the provider's request body as they are: the provider's own `body` with the ask's over it. A field the provider settles itself wins over them.
  body?: Record<string, unknown> | undefined
  // How long a provider may take to answer, and to send the next chunk once it did.
  timeouts: Timeouts
}

export interface Timeouts {
  connect: Duration
  idle: Duration
}

// A part of the reply, or the token counts the provider reports as it goes (each field when it knows it).
// Why the reply ended: the model finished (`stop`), hit `maxTokens` (`length`) or was cut by the provider's safety filter or refusal (`filtered`).
// A reply that still wanted tools when `maxSteps` ran out ends as `steps`.
export type Finish = 'stop' | 'length' | 'filtered' | 'steps'

// `toolUse` is a provider's finished tool call, which the loop answers and the reply never shows; `tool` is a call as the reply shows it, sent again as its status changes; `step` is a request to the model that ended, which `reply.steps` lists.
// `restart` drops the text so far: the tool loop sends it for a `schema` reply when a step that wrote some went on to call tools, as only the text of the last step is the object.
// `reasoning` is a part of the model's thinking as it streams, never mixed into `text`; `thinking` is a finished block of it, which the loop sends back with the calls and the reply never shows.
export type Piece = { text: string } | { reasoning: string } | { thinking: Thinking } | { usage: Partial<Usage> } | { finish: Finish } | { toolUse: ToolUse } | { tool: AiToolCall } | { step: Step } | { restart: true }

// Who answered a request: the provider and model that did, and how many requests the round took to get there (1 when the first answered).
export interface Served {
  provider: string
  model: string
  attempt: number
}

// What the retry layer sends the loop: a provider's pieces, after a `served` that comes before the first piece of content.
export type Inner = Piece | { served: Served }

export interface Provider {
  readonly name: string
  // The model used when neither `ask` nor `AI_MODEL` names one.
  readonly model?: string | undefined
  // The kinds of attachment it takes, both when absent; an ask holding another kind fails with an `unsupported` error before the provider is called.
  readonly accepts?: readonly Media['kind'][] | undefined
  // Starts the request when first read, and stops it, the body cancelled, when `signal` aborts or the iterator returns.
  stream: (request: ProviderRequest, signal: AbortSignal) => AsyncIterable<Piece>
  // Writes a recording down, for `transcribe()`; a provider without it, Anthropic, has no speech to text.
  transcribe?: ((request: TranscribeRequest, signal: AbortSignal) => Promise<string>) | undefined
  // Reads a text aloud, for `speak()`, the audio typed by its `type`.
  speak?: ((request: SpeakRequest, signal: AbortSignal) => Promise<Blob>) | undefined
  // One vector per text, in their order, for `embed()`.
  embed?: ((request: EmbedRequest, signal: AbortSignal) => Promise<number[][]>) | undefined
}

// The formats a text is read aloud in, the `response_format` of OpenAI's `/audio/speech`.
export type AudioFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'

export interface TranscribeRequest {
  audio: Blob
  model: string
  // An ISO 639-1 code such as `fr`, as the provider takes it, left out to let the model tell.
  language: string | undefined
  // How long the whole call may take.
  timeout: Duration
}

export interface SpeakRequest {
  text: string
  model: string
  voice: string | undefined
  speed: number | undefined
  format: AudioFormat | undefined
  timeout: Duration
}

export interface EmbedRequest {
  input: string[]
  model: string
  dimensions: number | undefined
  timeout: Duration
}

// Any action exported by a page module, whatever its input and honeypot.
export type ToolAction = Action<never, unknown>

// What a function tool receives besides the input the model gave.
export interface FunctionToolContext {
  // Aborts when the reply is stopped, as `options.signal` or the request does.
  signal: AbortSignal
}

export interface FunctionToolOptions<Spec extends Schema = Schema> {
  // What the model calls it by: letters, digits, `_` and `-`, up to 64 characters, unique among the `tools` of an ask.
  name: string
  // What the model reads to decide when to call it.
  description: string
  // The words a chat shows for a call to it, such as `Searched the docs`, in place of its name.
  label?: string | undefined
  // The object the model gives, a kay schema (`s.Object({ ... })`): a call it refuses is answered to the model, `run` never sees it.
  input: Spec
  // What the call does, with the input checked and typed by the schema: its result goes back to the model, as the text it is or as JSON. A throw tells the model the tool could not run, and goes to the app's log.
  run: (input: Static<Spec>, context: FunctionToolContext) => unknown
}

declare const functionTool: unique symbol

// A function the model may call, made by `tool()`: only `tool()` makes one, so a hand-written object of the same fields is no `FunctionTool`.
export interface FunctionTool {
  readonly [functionTool]: true
  readonly name: string
  readonly description: string
  readonly label?: string | undefined
  readonly input: Schema
  readonly run: (input: never, context: FunctionToolContext) => unknown
}

// A tool call waiting for `approval`'s yes: the tool's name, the arguments the model gave and the request being answered.
export interface ToolRequest {
  name: string
  input: Record<string, unknown>
  request: Request
}

// Answers whether the visitor agreed to a call; only `true` lets it run.
export type Confirm = (call: ToolRequest) => boolean | Promise<boolean>

// What `beforeRequest` is given before the provider is called: the messages (with their attachments) and the system prompt as the ask has them, the model chosen, and the options of the ask.
export interface RequestHookCall {
  messages: AiMessage[]
  system: string | undefined
  model: string
  options: AskOptions
}

// What `beforeRequest` returns to change the request: the messages and system prompt to send instead; a field left out stays as it was, and `system: undefined` sends none.
export interface RequestHookChange {
  messages?: AiMessage[] | undefined
  system?: string | undefined
}

// What `onSuccess` is given once a reply ended: its text, the tokens (undefined when the provider gave none), one entry per request, why it stopped, and whether it was stopped (by `reply.stop()`, an aborted request or a reader that left) rather than ending on its own.
export interface FinishHookCall {
  text: string
  usage: Usage | undefined
  steps: Step[]
  finish: Finish | undefined
  stopped: boolean
}

// What `onError` is given: the error the reply's readers get, or a request that failed and was retried or fell back.
export interface ErrorHookCall {
  error: unknown
}

// Hooks around an ask, set once in `ai({ ... })` and added to by the same names in `ask(..., { ... })`: the hooks of `ai()` run first, then the ask's. Each is given `context`, the request being answered. A throw in a hook that only notifies is reported with source `ai.<hook>` and never fails the reply.
export interface AskHooks {
  // Called before the provider is asked, after the input-length check, and before the limits count the ask: may return the `messages` and `system` to send instead (redact, add context), return `false` to refuse the ask, or throw an `AiError` (or `refuse()`, or any error) to refuse it, which fails the reply with it and calls `onError`.
  beforeRequest?: BeforeHook<RequestHookCall, RequestHookChange> | undefined
  // Called after each request of the reply to the provider, a tool loop making one per round.
  onStep?: Hook<Step> | undefined
  // Called as each tool call starts (`running`) and again as it ends (`done` or `failed`).
  onToolCall?: Hook<AiToolCall> | undefined
  // Called once the reply ended, finished, cut short or stopped (`stopped`).
  onSuccess?: Hook<FinishHookCall> | undefined
  // Called when the reply fails, with the error its readers get, and for each failed request that was retried or fell back.
  onError?: Hook<ErrorHookCall> | undefined

}

// How a request that fails before streaming anything is asked again: an `unavailable`, `rate-limited`, `timeout` or `network` error is retried, a refused key or request never is.
export interface RetryOptions {
  // The requests made to one model, the first included: 2 by default, 1 never retries.
  attempts?: number | undefined
  // The wait before the second request, doubled for each one after it and shortened by up to half at random so asks failing together do not retry together; `'500ms'` by default. A rate limit's `Retry-After` is waited instead.
  backoff?: Duration | undefined
  // The longest a wait may be, `'10s'` by default. A `Retry-After` past it is not waited: the next fallback is asked at once, else the error is thrown.
  maxWait?: Duration | undefined
}

// Another model to ask when the one asked keeps failing: the same provider unless `provider` names one.
export interface FallbackModel {
  model: string
  provider?: Provider | undefined
}

// Retry and fallback, set once in `ai({ ... })` and replaced as a whole by the same names in `ask(..., { ... })`.
export interface Resilience {
  // Asks again after a failure before the first piece of the reply, 2 requests per model by default; `false` never retries. A request that already streamed something is never asked again. The fake is not retried unless the ask itself names `retry`, and the `ai()` settings are not used for it.
  retry?: false | RetryOptions | undefined
  // The models asked in turn once the one before kept failing with `unavailable`, `rate-limited`, `timeout` or `network`, each with its own `retry`: `[]` for none. The fake falls back only on a list the ask itself gives.
  fallback?: readonly FallbackModel[] | undefined
}

export interface AskOptions extends AskHooks, Resilience {
  system?: string | undefined
  // The model for this reply: its id, or a name from `ai({ models })`; `ai({ default })` or `AI_MODEL` when left out.
  model?: string | undefined
  // 4096 by default, as Anthropic requires one.
  maxTokens?: number | undefined
  // Left out of an Anthropic request that thinks (`effort` of `'low'`, `'medium'` or `'high'`), which refuses one; models since 4.7 refuse any temperature, with their own message.
  temperature?: number | undefined
  // How much a reasoning model thinks before answering, `'none'` for a quick reply: sent as `reasoning_effort` to an OpenAI-compatible server, which is asked again without it if it refuses the field, and left out when not given. Anthropic gets adaptive thinking at that effort, its text summarized so it streams (`'none'` asks the lowest effort with thinking disabled, which a model refusing it is asked again without), and `temperature` is then left out while it thinks; a `thinking` in `body` replaces all of it.
  effort?: Reasoning | undefined
  // Asks the provider to cache the prompt so the next turn and tool step read it at a fraction of the price: on by default, `false` turns it off and `'1h'` keeps an Anthropic cache for an hour instead of 5 minutes.
  cache?: boolean | '1h' | undefined
  // Fields to add to the provider's request body as they are, such as `{ top_p: 0.9, seed: 7 }`, so a parameter kayjs-ai does not model needs no release. They are added to what the provider was built with in `body`, this ask's winning field by field (top level only), and a field kayjs-ai settles itself (`model`, `messages`, `stream`, the token limit, and when it sets them `tools`, the schema's output format, `temperature`, `reasoning` and `cache`) wins over them. A server refusing a field fails the reply with its own message.
  body?: Record<string, unknown> | undefined
  // Stops the reply when it aborts, as the request being answered does on its own.
  signal?: AbortSignal | undefined
  // Lets the reply finish on the server after the request being answered aborts, a visitor who reloaded or left: the provider request, the tool loop and every reader go on, and a `Chat` with `remember` shows the finished turn after the reload. Only `reply.stop()`, `signal` and the Chat's Stop end it, and a reader leaving early no longer does.
  outlive?: boolean | undefined
  // The documents the model was given, numbered as it cites them (`[1]`): `reply.progress()` carries them beside the text, and a `Chat` links each `[n]` to its source and lists the cited ones under the turn.
  sources?: readonly Source[] | undefined
  // How long to wait, as a duration: `connect` for the provider to start answering (`'30s'` by default), `idle` for the next chunk of a reply once it began (`'60s'` by default). A stall past either fails the reply with a `timeout` error. Each step of a tool loop counts them anew.
  timeout?: { connect?: Duration | undefined, idle?: Duration | undefined } | undefined
  // Who the limits and budget set in `ai()` count this ask for, and whose conversation a `Chat` with `keepOnServer` keeps, in place of the signed-in user its `key` names or the address of the request being answered: a job or a test names one.
  key?: string | undefined
  // Actions the model may call, each run as the visitor through the whole app, guards, validation and rate limits included; passing one is its opt-in. They need the request being answered, so `ask` with an action called outside one throws.
  // A `tool({ name, description, input, run })` is a plain function instead, run with the app's own rights and no visitor: it works outside a request, in a scheduled job or a queue worker, and is never held for approval nor asked of `approval`.
  tools?: readonly (ToolAction | FunctionTool)[] | undefined
  // The provider requests the tool loop may make, 5 by default; a reply still wanting tools after the last ends with `finish` `steps`.
  maxSteps?: number | undefined
  // Asked before each action call runs (a function tool is never asked), with its name, arguments and the request: only `true` lets it run, anything else tells the model the visitor has not confirmed it so it asks them first, and a throw fails the call like a tool that throws. A write the visitor must agree to, such as a booking, is checked here; a read answers `true`.
  // Left out, a tool not marked `tool: { readOnly: true }` is held until the visitor allows that very call (`Chat` draws an Allow button); `false` runs every action unasked.
  approval?: Confirm | false | undefined

  // The most characters the messages may hold together, 50,000 by default (the system prompt is not counted); a conversation past it fails the reply with a `too-long` error, 413 in an action, before the provider is called. `Infinity` lifts it.
  maxInputChars?: number | undefined
  // The most bytes one attachment may hold, bytes or a size such as `'5mb'`, 10 MB by default; a larger one fails the reply with a `too-long` error before the provider is called.
  maxSize?: ByteSize | undefined

  // Asks this provider instead of the one the environment names, such as `openai({ baseUrl })`; under `bun test` the fake answers in its place.
  provider?: Provider | undefined
}

// The options of an ask for an object.
export interface StructuredAskOptions<Spec extends Schema = Schema> extends AskOptions {
  // The object the model answers, a kay schema (`s.Object({ ... })`): `await ask(messages, { schema })` is the value it describes, typed by the schema and checked against it, and `for await` gives the object so far as it streams. An answer the schema refuses fails the reply with a `schema` error. Each provider is asked through its own JSON-schema output; `tools`, `maxSteps`, limits and `maxInputChars` apply as without one.
  schema: Spec
}

// A tool call as the reply shows it, plain data a chat renders: `running` until the action answers, then `done` or `failed`.
export interface AiToolCall {
  id: string
  name: string
  // The words for the call, from the `label` of the action's `tool` or of a function tool, which a chat shows in place of the name unless its `toolLabels` names the tool.
  label?: string | undefined
  // The arguments the model gave, `{}` when it gave none that parse as an object.
  input: Record<string, unknown>
  status: 'running' | 'done' | 'failed'
  // Set on a call held for the visitor's yes: the ticket a chat's Allow button posts back, which lets that very call run once on the next ask.
  approval?: string | undefined
  // What the model was told of the outcome, the action's answer or why the call failed; absent while running.
  result?: string | undefined
  // How long the call took in milliseconds, from the model's request to its result (an `approval` the app awaits counts); absent while running.
  ms?: number | undefined
}

// One request to the model, as `await reply.steps` lists them: a reply without tools makes one, a tool loop one per round.
export interface Step {
  // How long the request took, from sent to the end of the model's answer, the tools it called not counted.
  ms: number
  // The wait until the first piece of text, reasoning or tool call came; undefined when the model said nothing.
  firstTokenMs: number | undefined
  // The tokens of this request, undefined when the provider gave none (a tool loop estimates them from the characters, as its budget does).
  usage: Usage | undefined
  // Why the model stopped, undefined when the provider said nothing.
  finish: Finish | undefined
  // The tool calls the model made in this request, run, with their `ms`.
  calls: AiToolCall[]
  // The finished thinking blocks this request produced, signatures included, which a provider that thinks wants back with the calls; absent when it produced none.
  thinking?: Thinking[] | undefined
  // The provider and model that took this request. After a retry or a fallback they are the ones that answered, or the ones that failed for a request listed with `failed`.
  provider: string
  model: string
  // Which request of its round this is: 1 for the first, 2 for the retry or the fallback after a failure. A round that failed twice and then answered lists three steps, the two failed ones first.
  attempt: number
  // The kind of the error when this request failed before streaming anything and was retried, fell back or ended the reply; undefined for one that answered.
  failed: AiErrorKind | undefined
}

// The reply so far, for a chat to show: the text of all steps and every call, each as last seen, and the code blocks that were finished since the previous snapshot.
export interface Progress {
  text: string
  calls: AiToolCall[]
  // The code blocks of the text closed since the previous snapshot, highlighted with the app's own highlighter (`markdown.highlight` in `kay.config.ts`) and sanitized; absent when there are none or the app has no highlighter.
  code?: CodeBlock[] | undefined
  // What the model has thought so far, when the provider streams it (Anthropic's thinking, an OpenAI-compatible server's `reasoning_content`); absent when it did not. The text of `await` never holds it.
  reasoning?: string | undefined
  // Set when the ask has `outlive`, which tells a chat its Stop must end the reply on the server too.
  outlives?: true | undefined
  // The documents the text cites as `[n]`, from `ask({ sources })`; absent when there are none.
  sources?: Source[] | undefined
}

// A finished code block: `markup` is how the chat renders it as Markdown, which `html` replaces.
export interface CodeBlock {
  markup: string
  html: string
}

export interface DeltasOptions {
  // Called when the text starts over: a reply with a `schema` that wrote some text before calling tools keeps only the text of its last step, so a reader drops the pieces it has to make them add up to the answer. Called before the first piece of the new text, and only to a reader that was given some.
  onRestart?: (() => void) | undefined
}

// A reply: `await` gives its whole text, `for await` its snapshots, each the text so far, which an `await` block and a streaming action take as they are.
// It is no Promise, which an `await` block would read as one value; it sends nothing until it is first read.
export interface AiReply extends PromiseLike<string>, AsyncIterable<string> {
  // The snapshots, as `for await` gives them, in an object that is no thenable: an `async` function returns it as it is, where it would await the reply itself and lose the streaming.
  stream: () => AsyncIterable<string>
  // The pieces as they came, not the text so far.
  deltas: (options?: DeltasOptions) => AsyncIterable<string>
  // The token counts once the reply ended (with the cache reads and writes when the provider reported them), or undefined when the provider gave none or the reply failed; never rejects. Reading it starts the reply.
  readonly usage: Promise<Usage | undefined>
  // Why the reply ended, undefined when it failed or the provider said nothing; a reply stopped by `maxTokens` is `length`, which `await` returns as if it were whole. Never rejects, and reading it starts the reply.
  readonly finish: Promise<Finish | undefined>
  // Every change to the text or to a tool call, as a snapshot; an action returning it streams both to a chat. Empty replies yield nothing.
  progress: () => AsyncIterable<Progress>
  // The tool calls once the reply ended, in the order they were made; never rejects, and reading it starts the reply.
  readonly calls: Promise<AiToolCall[]>
  // One entry per request made to the model, in order, with how long it took, how long until it first spoke, its tokens, why it stopped and the tool calls it made (each with its `ms`): a tool loop makes one per round. The requests that ended when the reply failed or was stopped; never rejects, and reading it starts the reply.
  readonly steps: Promise<Step[]>
  // True for the reply a Chat's resume or stop call gets, which is the kept reply of an `outlive` ask or an empty one, so an action reading the reply on the server does it on the start alone: `if (!answer.resumed) void speak(answer)`.
  readonly resumed: boolean
  // Aborts the provider request; what was received stays the text of `await`.
  stop: () => void
}

// A value as it streams in: every field may be missing, those of a nested object or an array's items too, a string present as far as it came (so a literal or an enum is a plain string while it grows) and any other field once it is complete.
export type DeepPartial<Value> = Value extends string
  ? string
  : Value extends readonly (infer Item)[]
    ? DeepPartial<Item>[]
    : Value extends (...args: never[]) => unknown ? Value
      : Value extends Date ? Value
        : Value extends object ? { [Key in keyof Value]?: DeepPartial<Value[Key]> } : Value

// The reply to an ask with a `schema`: `await` gives the object, checked, `for await` the object so far, and the rest is the reply's own.
// It is no Promise, which an `await` block would read as one value; it sends nothing until it is first read.
export interface StructuredReply<Value, Snapshot = DeepPartial<Value>> extends PromiseLike<Value>, AsyncIterable<Snapshot> {
  // The snapshots, as `for await` gives them, in an object that is no thenable, so an `async` function returns it as it is.
  stream: () => AsyncIterable<Snapshot>
  // The pieces of the JSON text as they came; after a tool step that wrote some text `onRestart` is called, and the pieces from then on are the answer's.
  deltas: (options?: DeltasOptions) => AsyncIterable<string>
  readonly usage: Promise<Usage | undefined>
  readonly finish: Promise<Finish | undefined>
  readonly calls: Promise<AiToolCall[]>
  // The requests made to the model, as on `Reply`.
  readonly steps: Promise<Step[]>
  // True for the reply a Chat's resume or stop call gets, as on `Reply`.
  readonly resumed: boolean
  stop: () => void
}

// What `ask` gives for a schema: the checked value and its snapshots.
export type ReplyOf<Spec extends Schema> = StructuredReply<Static<Spec>>
