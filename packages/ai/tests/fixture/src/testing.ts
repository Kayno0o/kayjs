import type { Provider } from '@kaynooo/kayjs-ai'

// What the tests reach from the fixture's actions: the provider they ask, and what the tools did.
export const testing: { provider: Provider | undefined } = { provider: undefined }
export const done: string[] = []
