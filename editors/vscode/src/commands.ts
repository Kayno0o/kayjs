import type { CommandId } from './roots'
import { COMMANDS } from './roots'

// Registers every command the manifest contributes, so one added to COMMANDS without a handler fails to compile.
export function registerCommands<T>(register: (id: CommandId, run: () => unknown) => T, handlers: Record<CommandId, () => unknown>): T[] {
  return COMMANDS.map(id => register(id, handlers[id]))
}
