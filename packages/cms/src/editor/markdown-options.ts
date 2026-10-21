import type { ToolbarAction } from '@kaynooo/kayjs-ui'
import { context } from 'kay'

// The toolbar a collection's form asks of every Markdown box in it, provided where the form renders a field and read by the box, however deep in a group or a list it sits.
export const markdownToolbar = context<boolean | readonly ToolbarAction[] | undefined>(undefined)
