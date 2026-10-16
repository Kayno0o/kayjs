import type { TSchema } from 'elysia'
import type { Action, ServerAction } from '../runtime/action'
import type { FieldRules, FormRules } from '../runtime/validate'
import { isAction } from '../runtime/action'
import { localeState } from '../runtime/locale-state'
import { errorText } from './field-errors'

// The keywords the browser checks a field against, with the `error` message the server shows for it.
const CHECKED = new Set(['type', 'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'const', 'items', 'anyOf', 'error'])
// Per locale: a field's `error` may be a function wording itself in the request's.
const rulesCache = new WeakMap<object, Map<string, FormRules | null>>()

// The schemas of the actions a page's forms post to, for the page swap to check a form before posting it; a page whose forms post to none gets nothing.
export function formsScript(forms: Set<Action<never, unknown>>): string {
  const rules: Record<string, FormRules> = {}

  for (const action of forms) {
    const form = isAction(action) ? formRules(action) : undefined

    if (form)
      rules[action.url] = form
  }

  return Object.keys(rules).length === 0 ? '' : `<script type="application/json" data-kay-forms>${JSON.stringify(rules).replaceAll('<', '\\u003c')}</script>`
}

// A stand-in action, which a static site's page holds in place of one it cannot serve, has no schema to read.
function formRules(action: ServerAction<TSchema, unknown>): FormRules | undefined {
  if (typeof action.schema !== 'object' || action.schema === null)
    return undefined

  const locale = localeState()?.locale ?? ''
  const cached = rulesCache.get(action.schema) ?? new Map<string, FormRules | null>()
  let rules = cached.get(locale)

  if (rules === undefined) {
    const { properties, required = [] } = action.schema as { properties?: Record<string, unknown>, required?: string[] }

    rules = properties ? { properties: Object.fromEntries(Object.entries(properties).map(([name, field]) => [name, fieldRules(field)])), required } : null
    cached.set(locale, rules)
    rulesCache.set(action.schema, cached)
  }

  return rules ?? undefined
}

function fieldRules(field: unknown): FieldRules {
  const rules: Record<string, unknown> = {}

  for (const [keyword, value] of Object.entries(field as Record<string, unknown>)) {
    if (!CHECKED.has(keyword))
      continue

    if (keyword === 'error') {
      const text = errorText(value)

      if (text !== undefined)
        rules[keyword] = text
    }
    else if (keyword === 'items') {
      rules[keyword] = fieldRules(value)
    }
    else if (keyword === 'anyOf') {
      rules[keyword] = (value as unknown[]).map(fieldRules)
    }
    else {
      rules[keyword] = value
    }
  }

  return rules
}
