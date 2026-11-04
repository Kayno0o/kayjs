// What the slow routes saw of their signal, read by the test once the request timed out.
export const seen: Record<string, AbortSignal | undefined> = {}
