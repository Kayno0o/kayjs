// The key of a row whose `for` names none: the item's `id` when it has one, else the item itself, so a copy of an item is a new row.
export function rowKey(item: unknown): unknown {
  return typeof item === 'object' && item !== null && 'id' in item ? item.id : item
}
