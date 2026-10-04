import { context } from 'kay'

// The messages a FormDialog's last call was refused with, by field name, which each FormField inside it reads for its own `name`.
export const formIssues = context<(() => Record<string, string>) | undefined>(undefined)
