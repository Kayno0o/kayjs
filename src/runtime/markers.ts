// The markup the server writes and the browser reads back, apart from both renderers so each side imports it alone.

// The data of the comments around a dynamic part, `<!--[-->` and `<!--]-->`.
export const PART_START = '['
export const PART_END = ']'
// The data of the comment leading a `try` block the server rendered its `catch` block for.
export const FAILED = 'kay-failed'
// The element an island renders in.
export const ISLAND = 'slot[data-component]'
