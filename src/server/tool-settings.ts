import type { ActionTool } from '../runtime/action'

// What `tool` on an action or on a route's `detail` sets: undefined for none, else the name and description it gives.
export function toolSettings(tool: boolean | string | ActionTool | undefined): { name?: string | undefined, description?: string | undefined } | undefined {
  if (tool === undefined || tool === false)
    return undefined

  if (tool === true)
    return {}

  return typeof tool === 'string' ? { description: tool } : tool
}
