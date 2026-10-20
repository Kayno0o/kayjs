// Whether the browser moves a connected node where it stands (Chrome 133, Firefox 144), which keeps its iframe loaded, its video playing, its focus and its open popover; elsewhere a move takes the node out and puts it back, and the state is lost.
const moves = typeof Element !== 'undefined' && 'moveBefore' in Element.prototype

// Puts `node` before `before` in `parent`, moved in place when both are connected, else inserted.
export function place(parent: Node, node: Node, before: Node | null): void {
  if (moves && node.isConnected && parent.isConnected) {
    try {
      (parent as ParentNode & Node).moveBefore(node, before)

      return
    }
    catch {
      // Another document or shadow root, which only an insertion crosses.
    }
  }

  parent.insertBefore(node, before)
}
