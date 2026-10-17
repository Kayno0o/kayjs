import type { MessageValue } from '../runtime/i18n'
import { wording } from '../runtime/words.server'

// The texts kay itself shows a visitor, by the `kay.*` key an app's `src/messages/<locale>.ts` words them under; a site without the key reads this English. Placeholders are filled from the params the caller gives.
export const KAY_ENGLISH = {
  'kay.action.invalidFile': 'Invalid file type',
  'kay.action.serverError': 'Something went wrong on our side; try again later',
  'kay.action.bodyLimit': 'Too large to send; {size} at most',
  'kay.offline.title': 'Offline',
  'kay.offline.text': 'This page needs a connection, and none is open.',
  'kay.protection.honeypot': 'Leave this field empty',
  'kay.protection.minTime.early': 'Sent too fast; take a moment, then send it again',
  'kay.protection.minTime.expired': 'This form has expired; send it again',
  'kay.protection.proofOfWork.missing': 'Turn JavaScript on to send this form',
  'kay.protection.proofOfWork.expired': 'This form has expired; send it again',
  'kay.protection.proofOfWork.wrong': 'This form could not be checked; send it again',
  'kay.protection.rateLimit': 'Too many attempts; try again in {seconds} s',
} as const

export type KayWord = keyof typeof KAY_ENGLISH

// The `kay.*` text in the request's locale, its own English when the app gives none. Called inside the request's locale.
export function kayWord(key: KayWord, params?: Record<string, MessageValue>): string {
  return wording(key, KAY_ENGLISH[key], params)
}

export type InvalidWord = 'kay.invalid.required' | 'kay.invalid.tooShort' | 'kay.invalid.tooLong' | 'kay.invalid.pattern' | 'kay.invalid.format' | 'kay.invalid.tooFewItems' | 'kay.invalid.tooManyItems' | 'kay.invalid.tooSmall' | 'kay.invalid.tooBig' | 'kay.invalid.type'

// What a schema refusal without an `error` says: the `kay.invalid.*` text of its kind in the request's locale, else Elysia's own summary, which a site without the keys keeps reading.
export function invalidWord(kind: InvalidWord, summary: string | undefined, params?: Record<string, MessageValue>): string {
  return wording(kind, summary ?? 'Invalid value', params)
}

// The placeholders each `kay.invalid.*` message may hold; their English is the schema's own summary, which has none to check against.
export const INVALID_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'kay.invalid.required': [],
  'kay.invalid.tooShort': ['min'],
  'kay.invalid.tooLong': ['max'],
  'kay.invalid.pattern': [],
  'kay.invalid.format': ['format'],
  'kay.invalid.tooFewItems': ['min'],
  'kay.invalid.tooManyItems': ['max'],
  'kay.invalid.tooSmall': ['min'],
  'kay.invalid.tooBig': ['max'],
  'kay.invalid.type': [],
}
