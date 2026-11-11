// The markup the server writes and the browser reads back, apart from both renderers so each side imports it alone.

// The data of the comments around a dynamic part, `<!--[-->` and `<!--]-->`.
export const PART_START = '['
export const PART_END = ']'
// The data of the comment leading a `try` block the server rendered its `catch` block for.
export const FAILED = 'kay-failed'
// The element an island renders in.
export const ISLAND = 'slot[data-component]'
// The event an island fires on its element once hydrated.
export const HYDRATED = '$h'
// The island the server rendered with a title of its own set in its `head`, which the browser leaves the page's title to the last of.
export const TITLED_ATTRIBUTE = 'data-titled'
export const TITLED = `slot[${TITLED_ATTRIBUTE}]`
// The comments around the markup a form posting to an action carries for the server alone, as its honeypot: the browser sets it aside while it claims the form's content and puts it back.
export const KEPT_START = 'kay-kept'
export const KEPT_END = '/kay-kept'

// What a streamed page writes right after its shell, so a swap shows the shell before any block arrived, and what ends each part sent after it (the call of `server/swap`).
export const SHELL_END = '<!--kay-shell-->'
// The header of a response that streams, so the swap looks for `SHELL_END` in those alone.
export const STREAMED_HEADER = 'x-kay-streamed'
export const LATE_PART_END = '<script>$kayAwait()</script>'
