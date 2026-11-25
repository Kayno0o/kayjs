// JSON Schema extraction and compaction for MCP tools/list: strips boilerplate, form-coercion unions and no-op bounds.

import type { StandardSchemaV1 } from '@kayjs/kay/server'

const DEFAULT_FOLD_HOMOGENEOUS_MIN = 4
const SAFE_INT_MIN = Number.MIN_SAFE_INTEGER
const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER
const BOOLEAN_ENUM_VALUES = new Set(['true', 'false', '0', '1', 'yes', 'no', 'on', 'off'])

export interface JsonSchemaObject {
  type?: string | undefined
  properties?: Record<string, unknown> | undefined
  required?: string[] | undefined
  additionalProperties?: boolean | Record<string, unknown> | undefined
  [key: string]: unknown
}

export interface CompactSchemaOptions {
  /** Collapse form-coercion string branches in `anyOf`/`oneOf` for boolean/number/integer fields (default: true). */
  stripFormCoercion?: boolean | undefined
  /** Strip `x-*` vendor extension keys (default: true). */
  stripExtensions?: boolean | undefined
  /** Strip no-op bounds (`minLength: 0`, `minItems: 0`, `minProperties: 0`, `±MAX_SAFE_INTEGER`) and optional app-wide default caps (default: true). */
  stripDefaultBounds?: boolean | { maxLength?: number | undefined, maxItems?: number | undefined } | undefined
  /** Fold optional-only objects with >= N identical-schema properties into `additionalProperties` + a compact `Keys: ...` description (default: 4; `false` disables). */
  foldHomogeneousObjects?: number | false | undefined
}

interface StandardJsonSchemaCapable {
  '~standard'?: {
    jsonSchema?: {
      input?: (opts: { target: string }) => Record<string, unknown>
    } | undefined
  } | undefined
  toJSONSchema?: (() => Record<string, unknown>) | undefined
  jsonSchema?: Record<string, unknown> | undefined
}

interface ResolvedCompactConfig {
  enabled: boolean
  stripFormCoercion: boolean
  stripExtensions: boolean
  stripDefaultBounds: boolean
  defaultMaxLength: number | undefined
  defaultMaxItems: number | undefined
  foldHomogeneousMin: number | false
}

const DEFAULT_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {},
}

const STRIPPED_SCHEMA_KEYS = new Set(['$schema', '$id', '$comment'])

function resolveCompactConfig(opt: boolean | CompactSchemaOptions | undefined): ResolvedCompactConfig {
  if (opt === false) {
    return {
      enabled: false,
      stripFormCoercion: false,
      stripExtensions: false,
      stripDefaultBounds: false,
      defaultMaxLength: undefined,
      defaultMaxItems: undefined,
      foldHomogeneousMin: false,
    }
  }
  const cfg = opt === true || opt === undefined ? {} : opt
  const bounds = cfg.stripDefaultBounds
  return {
    enabled: true,
    stripFormCoercion: cfg.stripFormCoercion ?? true,
    stripExtensions: cfg.stripExtensions ?? true,
    stripDefaultBounds: bounds !== false,
    defaultMaxLength: typeof bounds === 'object' ? bounds.maxLength : undefined,
    defaultMaxItems: typeof bounds === 'object' ? bounds.maxItems : undefined,
    foldHomogeneousMin: cfg.foldHomogeneousObjects !== undefined ? cfg.foldHomogeneousObjects : DEFAULT_FOLD_HOMOGENEOUS_MIN,
  }
}

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return typeof value === 'object'
    && value !== null
    && '~standard' in value
    && typeof (value as { '~standard'?: { validate?: unknown } })['~standard']?.validate === 'function'
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isBooleanCoercionBranch(branch: unknown): boolean {
  if (!isPlainRecord(branch) || branch.type !== 'string')
    return false
  if (branch.format === 'boolean')
    return true
  if (Array.isArray(branch.enum) && branch.enum.length > 0 && branch.enum.every(v => typeof v === 'string' && BOOLEAN_ENUM_VALUES.has(v.toLowerCase())))
    return true
  return false
}

function isNumericCoercionBranch(branch: unknown): boolean {
  if (!isPlainRecord(branch) || branch.type !== 'string')
    return false
  return branch.format === 'numeric' || branch.format === 'number' || branch.format === 'integer'
}

function collapseCoercionVariants(variants: unknown[]): { variants: unknown[], liftedDefault?: unknown, liftedDescription?: string | undefined } {
  let hasBoolean = false
  let hasNumber = false
  for (const v of variants) {
    if (!isPlainRecord(v))
      continue
    if (v.type === 'boolean')
      hasBoolean = true
    if (v.type === 'number' || v.type === 'integer')
      hasNumber = true
  }
  if (!hasBoolean && !hasNumber)
    return { variants }

  let liftedDefault: unknown
  let liftedDescription: string | undefined
  const kept: unknown[] = []

  for (const v of variants) {
    if (hasBoolean && isBooleanCoercionBranch(v)) {
      const rec = v as Record<string, unknown>
      if (liftedDefault === undefined && typeof rec.default === 'boolean')
        liftedDefault = rec.default
      if (liftedDescription === undefined && typeof rec.description === 'string' && rec.description.trim().length > 0)
        liftedDescription = rec.description
      continue
    }
    if (hasNumber && isNumericCoercionBranch(v)) {
      const rec = v as Record<string, unknown>
      if (liftedDefault === undefined && typeof rec.default === 'number')
        liftedDefault = rec.default
      if (liftedDescription === undefined && typeof rec.description === 'string' && rec.description.trim().length > 0)
        liftedDescription = rec.description
      continue
    }
    kept.push(v)
  }

  return { variants: kept, liftedDefault, liftedDescription }
}

function tryFoldHomogeneousObject(obj: Record<string, unknown>, minKeys: number): void {
  const props = obj.properties
  if (!isPlainRecord(props))
    return
  if (Array.isArray(obj.required) && obj.required.length > 0)
    return
  if (obj.additionalProperties !== undefined && obj.additionalProperties !== false)
    return

  const entries = Object.entries(props)
  if (entries.length < minKeys)
    return

  let signature: string | undefined
  let sharedSchema: Record<string, unknown> | undefined

  for (const [, val] of entries) {
    if (!isPlainRecord(val))
      return
    if (typeof val.description === 'string' && val.description.length > 0)
      return
    const serialized = JSON.stringify(val)
    if (signature === undefined) {
      signature = serialized
      sharedSchema = val
    }
    else if (serialized !== signature) {
      return
    }
  }

  if (sharedSchema === undefined)
    return

  const keysHint = `Keys: ${entries.map(([k]) => k).join(', ')}`
  const existingDesc = typeof obj.description === 'string' && obj.description.trim().length > 0
    ? obj.description.trim()
    : undefined
  obj.description = existingDesc ? `${existingDesc} (${keysHint})` : keysHint
  obj.additionalProperties = sharedSchema
  delete obj.properties
}

function collectSchemaRefs(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node)
      collectSchemaRefs(item, out)
    return
  }
  if (node === null || typeof node !== 'object')
    return
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === '$ref' && typeof v === 'string')
      out.add(v)
    else
      collectSchemaRefs(v, out)
  }
}

function pruneUnusedDefs(root: JsonSchemaObject): void {
  for (const defKey of ['$defs', 'definitions'] as const) {
    const defs = root[defKey]
    if (defs === null || typeof defs !== 'object' || Array.isArray(defs))
      continue

    const defsRecord = defs as Record<string, unknown>
    const prefix = `#/${defKey}/`
    const referenced = new Set<string>()
    const queue: unknown[] = []

    for (const [k, v] of Object.entries(root)) {
      if (k !== defKey)
        queue.push(v)
    }

    const visitedDefs = new Set<string>()
    while (queue.length > 0) {
      const next = queue.pop()
      const found = new Set<string>()
      collectSchemaRefs(next, found)
      for (const ref of found) {
        if (!ref.startsWith(prefix))
          continue
        const name = ref.slice(prefix.length)
        if (!visitedDefs.has(name) && Object.prototype.hasOwnProperty.call(defsRecord, name)) {
          visitedDefs.add(name)
          referenced.add(name)
          queue.push(defsRecord[name])
        }
      }
    }

    const kept: Record<string, unknown> = {}
    for (const [name, def] of Object.entries(defsRecord)) {
      if (referenced.has(name))
        kept[name] = def
    }
    if (Object.keys(kept).length === 0)
      delete root[defKey]
    else
      root[defKey] = kept
  }
}

function compactSchemaNode(node: unknown, cfg: ResolvedCompactConfig, propName?: string, isRoot = false): unknown {
  if (Array.isArray(node))
    return node.map(item => compactSchemaNode(item, cfg))
  if (node === null || typeof node !== 'object')
    return node

  const src = node as Record<string, unknown>
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(src)) {
    if (value === undefined || STRIPPED_SCHEMA_KEYS.has(key))
      continue
    if (cfg.stripExtensions && key.startsWith('x-'))
      continue
    if (key === 'additionalProperties' && value === true)
      continue
    if (key === 'required' && Array.isArray(value) && value.length === 0)
      continue
    if (key === 'description' && typeof value === 'string' && value.trim().length === 0)
      continue
    if (key === 'title' && typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.length === 0 || (propName !== undefined && trimmed.toLowerCase() === propName.toLowerCase()))
        continue
    }
    if (cfg.stripDefaultBounds) {
      if ((key === 'minLength' || key === 'minItems' || key === 'minProperties') && value === 0)
        continue
      if (key === 'minimum' && value === SAFE_INT_MIN)
        continue
      if (key === 'maximum' && value === SAFE_INT_MAX)
        continue
      if (key === 'maxLength' && cfg.defaultMaxLength !== undefined && value === cfg.defaultMaxLength)
        continue
      if (key === 'maxItems' && cfg.defaultMaxItems !== undefined && value === cfg.defaultMaxItems)
        continue
    }

    if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const propsOut: Record<string, unknown> = {}
      for (const [pKey, pVal] of Object.entries(value as Record<string, unknown>))
        propsOut[pKey] = compactSchemaNode(pVal, cfg, pKey, false)
      out[key] = propsOut
      continue
    }

    out[key] = compactSchemaNode(value, cfg)
  }

  if (cfg.stripFormCoercion) {
    for (const unionKey of ['anyOf', 'oneOf'] as const) {
      const rawVariants = out[unionKey]
      if (!Array.isArray(rawVariants) || rawVariants.length < 2)
        continue
      const { variants, liftedDefault, liftedDescription } = collapseCoercionVariants(rawVariants)
      if (variants.length === rawVariants.length)
        continue
      if (variants.length === 1 && isPlainRecord(variants[0])) {
        delete out[unionKey]
        const single = variants[0]
        for (const [k, v] of Object.entries(single)) {
          if (out[k] === undefined)
            out[k] = v
        }
        if (liftedDefault !== undefined && out.default === undefined)
          out.default = liftedDefault
        if (liftedDescription !== undefined && out.description === undefined)
          out.description = liftedDescription
      }
      else if (variants.length > 0) {
        out[unionKey] = variants
        if (liftedDefault !== undefined && out.default === undefined)
          out.default = liftedDefault
        if (liftedDescription !== undefined && out.description === undefined)
          out.description = liftedDescription
      }
    }
  }

  if (!isRoot && cfg.foldHomogeneousMin !== false && cfg.foldHomogeneousMin > 0)
    tryFoldHomogeneousObject(out, cfg.foldHomogeneousMin)

  return out
}

/** Strips JSON Schema boilerplate, form-coercion unions, `x-*` extensions, no-op bounds, and homogeneous records. */
export function compactSchema(raw: Record<string, unknown>, options?: CompactSchemaOptions): JsonSchemaObject {
  const cfg = resolveCompactConfig(options ?? true)
  const compacted = compactSchemaNode(raw, cfg, undefined, true) as JsonSchemaObject
  pruneUnusedDefs(compacted)
  if (compacted.type === undefined)
    compacted.type = 'object'
  if (compacted.type === 'object' && compacted.properties === undefined && compacted.additionalProperties === undefined)
    compacted.properties = {}
  return compacted
}

export function normalizeObjectSchema(raw: Record<string, unknown> | undefined, compact: boolean | CompactSchemaOptions): JsonSchemaObject {
  if (!raw || typeof raw !== 'object')
    return { ...DEFAULT_INPUT_SCHEMA }
  if (compact !== false)
    return compactSchema(raw, compact === true ? undefined : compact)
  const copy: JsonSchemaObject = { ...raw }
  if (copy.type === undefined)
    copy.type = 'object'
  if (copy.type === 'object' && copy.properties === undefined)
    copy.properties = {}
  return copy
}

/** Extracts an MCP-compatible JSON Schema object from a Standard Schema (Zod 4, Valibot, ArkType, etc.). */
export function schemaToJsonSchema(
  schema: StandardSchemaV1 | undefined,
  options?: { compact?: boolean | CompactSchemaOptions | undefined },
): JsonSchemaObject {
  const compact = options?.compact ?? true
  if (schema === undefined)
    return { ...DEFAULT_INPUT_SCHEMA }

  const candidate = schema as unknown as StandardJsonSchemaCapable
  const stdJson = candidate['~standard']?.jsonSchema
  if (stdJson && typeof stdJson.input === 'function') {
    for (const target of ['draft-2020-12', 'draft-07']) {
      try {
        const out = stdJson.input({ target })
        if (out && typeof out === 'object')
          return normalizeObjectSchema(out, compact)
      }
      catch {
        // Try next JSON Schema draft target
      }
    }
  }

  if (typeof candidate.toJSONSchema === 'function') {
    try {
      const out = candidate.toJSONSchema()
      if (out && typeof out === 'object')
        return normalizeObjectSchema(out, compact)
    }
    catch {
      // Fall through to default object schema
    }
  }

  if (candidate.jsonSchema && typeof candidate.jsonSchema === 'object')
    return normalizeObjectSchema(candidate.jsonSchema, compact)

  return { ...DEFAULT_INPUT_SCHEMA }
}
