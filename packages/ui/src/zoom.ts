// Where a plate sits under the frame it is looked at through: how far in it is drawn, and where its
// top-left corner has been taken. The plate is the frame's own size at rest, which is what lets a
// picture fitted to the frame and anything standing on it be taken in and out together.
//
// None of this touches the DOM, so the gestures in `ZoomPane` are the only part that needs a browser.

export interface Plate {
  // How far in the plate is drawn, 1 being fitted to its frame.
  scale: number
  x: number
  y: number
}

export interface Frame {
  width: number
  height: number
}

// How far in a plate may be taken before it stops answering.
export const MOST = 8

// How far one notch of the wheel, or one press of a zoom button, takes it.
export const NOTCH_ZOOM = 1.15

// A wheel says how far in lines or in pages on some browsers, and in pixels on the rest.
const LINE = 16
const PAGE = 400
const NOTCH = 100

// A plate as it starts, and as fitting it puts it back: filling its frame, taken nowhere.
export function fitted(): Plate {
  return { scale: 1, x: 0, y: 0 }
}

// How far a wheel event takes the plate in or out, whichever units the browser reports it in.
export function wheelZoom(deltaY: number, deltaMode = 0, notch = NOTCH_ZOOM): number {
  const travelled = deltaY * (deltaMode === 1 ? LINE : deltaMode === 2 ? PAGE : 1)

  return notch ** (-travelled / NOTCH)
}

// The plate drawn closer or further off, held still at the point of the frame under the pointer.
export function zoomedAt(plate: Plate, at: { x: number, y: number }, by: number, most = MOST): Plate {
  const scale = Math.min(Math.max(plate.scale * by, 1), most)
  // What the scale really changed by, since the clamp may have swallowed part of the gesture.
  const real = scale / plate.scale

  return { scale, x: at.x - (at.x - plate.x) * real, y: at.y - (at.y - plate.y) * real }
}

export function movedBy(plate: Plate, dx: number, dy: number): Plate {
  return { ...plate, x: plate.x + dx, y: plate.y + dy }
}

// The plate held against its frame, so no gesture can leave a gap down one side: fitted, it sits still; taken in, it may only be moved as far as its own edges.
export function held(plate: Plate, frame: Frame): Plate {
  return {
    scale: plate.scale,
    x: Math.min(Math.max(plate.x, frame.width - frame.width * plate.scale), 0),
    y: Math.min(Math.max(plate.y, frame.height - frame.height * plate.scale), 0),
  }
}
