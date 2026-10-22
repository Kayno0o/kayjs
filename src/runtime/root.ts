// What the server writes on `<html>` and the page swap reads back, apart from the markers the entry holds, so only the swap's chunk ships it.

// The meta holding the attributes the layouts and the page set on `<html>`, as JSON by name, which the page swap compares with the next page's.
export const ROOT_ATTRIBUTES = 'kay-html'
// What kay sets on `<html>` from the page's language, which an `html` tag does not.
export const LOCALE_ATTRIBUTES = new Set(['dir'])
