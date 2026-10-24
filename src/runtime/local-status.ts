// Answers meaning "ask again later": a `local()` write answered with one stays queued, and the server never keeps such an answer for a retry.
export const RETRY_LATER = [408, 425, 429] as const
