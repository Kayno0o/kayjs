// The keyword lists HTML attributes share across tags, which `kay check` types by name: TypeScript names the alias in its message instead of the words, so the hint reads them from here.
// HTML reads the method case-insensitively and templates habitually write it in capitals, so both spellings go.
export const FORM_METHODS = ['get', 'post', 'dialog', 'GET', 'POST', 'DIALOG'] as const

export const FORM_ENCODINGS = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'] as const

export const REFERRER_POLICIES = ['', 'no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url'] as const

export const CROSS_ORIGINS = ['', 'anonymous', 'use-credentials'] as const

// Each list by the name `src/runtime/jsx.ts` gives its type.
export const NAMED_KEYWORDS: Record<string, readonly string[]> = { FormMethod: FORM_METHODS, FormEncoding: FORM_ENCODINGS, ReferrerPolicy: REFERRER_POLICIES, CrossOrigin: CROSS_ORIGINS }
