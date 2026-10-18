// Stands in for a highlighted code block while the rest of the reply is sanitized.
export const MARK = '\uE100'
export const MARKED = /\uE100(\d+)\uE100/g

// The marker is private to the swap: one in a model's text could place a block's html where it never was.
export const withoutMarker = (text: string) => text.replaceAll(MARK, '')
