// Rejects when it loads, so a component importing it meets a promise that failed before it rendered.
export const rows = Promise.reject<string[]>(new Error('down'))
