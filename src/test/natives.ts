// Bun's own web classes, as they were when the test process first loaded kay/test, its preload doing so before any test file.
// A DOM a test registers, such as happy-dom's, replaces the globals in every file of the run, and Elysia reads Bun's: `headers.toJSON()` among others.
export const { Request: NativeRequest, Headers: NativeHeaders, URL: NativeURL, FormData: NativeFormData, WebSocket: NativeWebSocket } = globalThis
