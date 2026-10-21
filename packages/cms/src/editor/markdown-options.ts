import type { ToolbarAction } from '../kay/contract'
import { context } from 'kay'

export interface MarkdownOptions {
  toolbar?: boolean | readonly ToolbarAction[] | undefined
  previewClass?: string | undefined
}

// What a collection's form asks of every Markdown box in it, provided where the form renders a field and read by the box, however deep in a group or a list it sits.
export const markdownOptions = context<MarkdownOptions>({})
