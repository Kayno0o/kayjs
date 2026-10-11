import { solveWork } from './work'

// Solves each challenge it is sent off the page's thread.
addEventListener('message', (event: MessageEvent<string>) => postMessage(solveWork(event.data)))
