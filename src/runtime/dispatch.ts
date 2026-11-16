import { KayError } from './kay-error'

// The handler a message's `type` names, given the message: one function per type in place of a `switch`, every type handled, as the compiler checks.
// A type no handler names, such as one a newer server sends, throws, saying which.
// kept: request
export function dispatch<Message extends { type: string }, Handlers extends { [Type in Message['type']]: (message: Extract<Message, { type: Type }>) => unknown }>(message: Message, handlers: Handlers): ReturnType<Handlers[Message['type']]> {
  if (!Object.hasOwn(handlers, message.type))
    throw new KayError('argument-invalid', `kay: dispatch() has no handler for a message of type ${message.type}`)

  return (handlers[message.type as Message['type']] as unknown as (message: Message) => ReturnType<Handlers[Message['type']]>)(message)
}
