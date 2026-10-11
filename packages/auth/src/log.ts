import { logFrom } from 'kay'

// Where kayjs-auth reports what it catches and goes on from: where the app's `log` setting sends kay's own messages, under the request being answered.
export const log = logFrom('kayjs-auth')
