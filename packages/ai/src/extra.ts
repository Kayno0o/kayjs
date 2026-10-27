import { configError } from 'kay/library'

// The fields an app sends that kayjs-ai does not model, checked to be a plain object so a stray array or string never reaches a provider's body.
export function extraBody(value: unknown, where: string): Record<string, unknown> | undefined {
  if (value === undefined)
    return undefined

  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw configError(`${where} is an object of fields to add to the request body`)

  return value as Record<string, unknown>
}
