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
// Under `kay dev` the rules are read again each time, as a messages file may have changed the text a function returns.
export function formsScript(forms: Set<Action<never, unknown>>, dev?: boolean): string {
  const rules = new Map<string, string>()

  for (const action of forms) {
    const form = isAction(action) ? formRules(action, dev) : undefined

    if (form)
      rules.set(action.url, `${escapeScript(JSON.stringify(action.url))}:${rulesJson(form)}`)
  }

  return rules.size === 0 ? '' : `<script type="application/json" data-kay-forms>{${[...rules.values()].join(',')}}</script>`
}

// The rules as the script holds them, written once per rules object, which `formRules` keeps per schema and locale.
const rulesJsons = new WeakMap<FormRules, string>()

function rulesJson(form: FormRules): string {
  let json = rulesJsons.get(form)

  if (json === undefined)
    rulesJsons.set(form, json = escapeScript(JSON.stringify(form)))

  return json
}

function escapeScript(json: string): string {
  return json.replaceAll('<', '\\u003c')
}

// A stand-in action, which a static site's page holds in place of one it cannot serve, has no schema to read.
function formRules(action: ServerAction<TSchema, unknown>, dev: boolean | undefined): FormRules | undefined {
  if (typeof action.schema !== 'object' || action.schema === null)
    return undefined

  const locale = localeState()?.locale ?? ''
  const cached = rulesCache.get(action.schema) ?? new Map<string, FormRules | null>()
  let rules = dev ? undefined : cached.get(locale)

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
