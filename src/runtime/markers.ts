// The markup the server writes and the browser reads back, apart from both renderers so each side imports it alone.

// The data of the comments around a dynamic part, `<!--[-->` and `<!--]-->`.
export const PART_START = '['
export const PART_END = ']'
// The data of the comment leading a `try` block the server rendered its `catch` block for.
export const FAILED = 'kay-failed'
// The element an island renders in.
export const ISLAND = 'slot[data-component]'
// The meta naming the attributes the layouts and the page set on `<html>`, which the page swap replaces with the next page's.
export const ROOT_ATTRIBUTES = 'kay-html'
