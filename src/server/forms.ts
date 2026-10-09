import type { TSchema } from 'elysia'
import type { Action, ServerAction } from '../runtime/action'
import type { FieldRules, FormRules } from '../runtime/validate'
import { isAction } from '../runtime/action'

// The keywords the browser checks a field against, with the `error` message the server shows for it.
const CHECKED = new Set(['type', 'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'const', 'items', 'anyOf', 'error'])
const rulesCache = new WeakMap<object, FormRules | null>()

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

function formRules(action: ServerAction<TSchema, unknown>): FormRules | undefined {
  let rules = rulesCache.get(action.schema)

  if (rules === undefined) {
    const { properties, required = [] } = action.schema as { properties?: Record<string, unknown>, required?: string[] }

    rules = properties ? { properties: Object.fromEntries(Object.entries(properties).map(([name, field]) => [name, fieldRules(field)])), required } : null
    rulesCache.set(action.schema, rules)
  }

  return rules ?? undefined
}

function fieldRules(field: unknown): FieldRules {
  const rules: Record<string, unknown> = {}

  for (const [keyword, value] of Object.entries(field as Record<string, unknown>)) {
    if (!CHECKED.has(keyword) || (keyword === 'error' && typeof value !== 'string'))
      continue

    rules[keyword] = keyword === 'items' ? fieldRules(value) : keyword === 'anyOf' ? (value as unknown[]).map(fieldRules) : value
  }

  return rules
}
