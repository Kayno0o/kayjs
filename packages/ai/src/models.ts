import type { Provider } from './types'
import { configError } from 'kay/library'

// A model an app names once in `ai({ models })`: its id alone, or its id with the provider that serves it.
export type NamedModel = string | { model: string, provider?: Provider | undefined }

export interface ModelsOptions {
  // Models by the name an ask passes as `model`, such as `{ fast: 'claude-haiku-4-5', smart: { model: 'gpt-5', provider: openai({ apiKey }) } }`. The names `imageAlt` and `translate` choose what drafts alt text and what `kay i18n translate` asks. A name shadows a model id spelled the same, and names resolve in `model` of `ask`, `fallback`, `embed`, `transcribe` and `speak`.
  models?: Record<string, NamedModel> | undefined
  // The name in `models` an ask without `model` uses, in place of `AI_MODEL`.
  default?: string | undefined
}

export interface Resolved {
  model: string
  provider: Provider | undefined
}

const SLOT = Symbol.for('kayjs-ai.models')

interface Set {
  models: Record<string, NamedModel>
  default: string | undefined
}

// What `ai()` set, on the global so every copy of the library in the process shares it.
function slot(): Set | undefined {
  return (globalThis as { [SLOT]?: Set })[SLOT]
}

function entryOf(name: string, value: unknown): Resolved {
  const entry = typeof value === 'string' ? { model: value, provider: undefined } : value as { model?: unknown, provider?: Provider } | null

  if (typeof entry !== 'object' || entry === null || typeof entry.model !== 'string' || entry.model === '')
    throw configError('ai', 'models', `ai({ models }).${name} is a model id or { model, provider? }, with the model's id`)

  return { model: entry.model, provider: entry.provider }
}

export function configureModels({ models, default: fallback }: ModelsOptions): void {
  if (models !== undefined && (typeof models !== 'object' || models === null || Array.isArray(models)))
    throw configError('ai', 'models', 'ai({ models }) is an object of model ids or { model, provider? } by name')

  for (const [name, value] of Object.entries(models ?? {}))
    entryOf(name, value)

  if (fallback !== undefined && !Object.hasOwn(models ?? {}, fallback)) {
    throw configError('ai', 'default', `ai({ default }) names ${JSON.stringify(fallback)}, which ai({ models }) does not list`)
  }

  (globalThis as { [SLOT]?: Set })[SLOT] = { models: models ?? {}, default: fallback }
}

// The model a name in `ai({ models })` stands for; undefined for a name the app did not give, which is then a model id as it is.
export function named(name: string): Resolved | undefined {
  const models = slot()?.models

  return models !== undefined && Object.hasOwn(models, name) ? entryOf(name, models[name]) : undefined
}

// The model an ask without `model` uses, when `ai({ default })` names one.
export function defaultNamed(): Resolved | undefined {
  const name = slot()?.default

  return name === undefined ? undefined : named(name)
}

// `{ model: role }` for a task of the library whose name the app listed in `ai({ models })`, else nothing, so the task asks the default; a model the call itself names beats the role.
export function roleModel(role: 'imageAlt' | 'translate', own?: string): { model?: string } {
  if (own !== undefined)
    return { model: own }

  return named(role) === undefined ? {} : { model: role }
}
