// What a model can make of a tool call, so a hostile or looping one costs a bounded amount.
export const MAX_CALLS_PER_STEP = 16
export const MAX_ARGUMENTS = 65_536
// Far past any tool's name: a longer one names no tool and the loop answers it as unknown.
export const MAX_NAME_LENGTH = 256
// Calls a provider keeps while a step streams: a few past the cap, which the loop answers as too many.
export const MAX_STREAMED_CALLS = MAX_CALLS_PER_STEP + 1
