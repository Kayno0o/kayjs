// Preloaded into an AVIF worker so it never answers: its first message listener swallows every task before the worker's own handler sees it.
globalThis.addEventListener('message', event => event.stopImmediatePropagation())
