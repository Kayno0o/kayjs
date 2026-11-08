// The dev tool's drawings: the icons of its buttons and tabs, and the kay mark. Split from dev-tool.ts, which the dev server serves with the modules it imports.

export const SVG = 'http://www.w3.org/2000/svg'

// Icons of Lucide 0.469.0 (https://lucide.dev), under the ISC licence: Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT), all other copyright (c) for Lucide are held by Lucide Contributors 2022.
// Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
// The portions of Lucide that come from Feather are under the MIT licence: Copyright (c) 2013-2022 Cole Bemis. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
// Each is a 24 by 24 drawing as its nodes, `tag~attribute~value~...` joined by `|`.
const ICONS = {
  'circle-x': 'circle~cx~12~cy~12~r~10|path~d~m15 9-6 6|path~d~m9 9 6 6',
  'triangle-alert': 'path~d~m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3|path~d~M12 9v4|path~d~M12 17h.01',
  'database': 'ellipse~cx~12~cy~5~rx~9~ry~3|path~d~M3 5V19A9 3 0 0 0 21 19V5|path~d~M3 12A9 3 0 0 0 21 12',
  'list-checks': 'path~d~m3 17 2 2 4-4|path~d~m3 7 2 2 4-4|path~d~M13 6h8|path~d~M13 12h8|path~d~M13 18h8',
  'server': 'rect~width~20~height~8~x~2~y~2~rx~2~ry~2|rect~width~20~height~8~x~2~y~14~rx~2~ry~2|line~x1~6~x2~6.01~y1~6~y2~6|line~x1~6~x2~6.01~y1~18~y2~18',
  'list-ordered': 'path~d~M10 12h11|path~d~M10 18h11|path~d~M10 6h11|path~d~M4 10h2|path~d~M4 6h1v4|path~d~M6 18H4c0-1 2-2 2-3s-1-1.5-2-1',
  'scan-search': 'path~d~M3 7V5a2 2 0 0 1 2-2h2|path~d~M17 3h2a2 2 0 0 1 2 2v2|path~d~M21 17v2a2 2 0 0 1-2 2h-2|path~d~M7 21H5a2 2 0 0 1-2-2v-2|circle~cx~12~cy~12~r~3|path~d~m16 16-1.9-1.9',
  'key-round': 'path~d~M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z|circle~cx~16.5~cy~7.5~r~.5~fill~currentColor',
  'image': 'rect~width~18~height~18~x~3~y~3~rx~2~ry~2|circle~cx~9~cy~9~r~2|path~d~m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21',
  'gauge': 'path~d~m12 14 4-4|path~d~M3.34 19a10 10 0 1 1 17.32 0',
  'route': 'circle~cx~6~cy~19~r~3|path~d~M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15|circle~cx~18~cy~5~r~3',
  'languages': 'path~d~m5 8 6 6|path~d~m4 14 6-6 2-3|path~d~M2 5h12|path~d~M7 2h1|path~d~m22 22-5-10-5 10|path~d~M14 18h6',
  'boxes': 'path~d~M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z|path~d~m7 16.5-4.74-2.85|path~d~m7 16.5 5-3|path~d~M7 16.5v5.17|path~d~M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z|path~d~m17 16.5-5-3|path~d~m17 16.5 4.74-2.85|path~d~M17 16.5v5.17|path~d~M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z|path~d~M12 8 7.26 5.15|path~d~m12 8 4.74-2.85|path~d~M12 13.5V8',
  'mail': 'rect~width~20~height~16~x~2~y~4~rx~2|path~d~m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7',
  'network': 'rect~x~16~y~16~width~6~height~6~rx~1|rect~x~2~y~16~width~6~height~6~rx~1|rect~x~9~y~2~width~6~height~6~rx~1|path~d~M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3|path~d~M12 12V8',
  'crosshair': 'circle~cx~12~cy~12~r~10|line~x1~22~x2~18~y1~12~y2~12|line~x1~6~x2~2~y1~12~y2~12|line~x1~12~x2~12~y1~6~y2~2|line~x1~12~x2~12~y1~22~y2~18',
  'maximize-2': 'polyline~points~15 3 21 3 21 9|polyline~points~9 21 3 21 3 15|line~x1~21~x2~14~y1~3~y2~10|line~x1~3~x2~10~y1~21~y2~14',
  'minimize-2': 'polyline~points~4 14 10 14 10 20|polyline~points~20 10 14 10 14 4|line~x1~14~x2~21~y1~10~y2~3|line~x1~3~x2~10~y1~21~y2~14',
  'panel-right': 'rect~width~18~height~18~x~3~y~3~rx~2|path~d~M15 3v18',
  'panel-left': 'rect~width~18~height~18~x~3~y~3~rx~2|path~d~M9 3v18',
  'panel-bottom': 'rect~width~18~height~18~x~3~y~3~rx~2|path~d~M3 15h18',
  'app-window': 'rect~x~2~y~4~width~20~height~16~rx~2|path~d~M10 4v4|path~d~M2 8h20|path~d~M6 4v4',
  'x': 'path~d~M18 6 6 18|path~d~m6 6 12 12',
  'copy': 'rect~width~14~height~14~x~8~y~8~rx~2~ry~2|path~d~M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2',
  'check': 'path~d~M20 6 9 17l-5-5',
  'clipboard-copy': 'rect~width~8~height~4~x~8~y~2~rx~1~ry~1|path~d~M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2|path~d~M16 4h2a2 2 0 0 1 2 2v4|path~d~M21 14H11|path~d~m15 10-4 4 4 4',
  'lock': 'rect~width~18~height~11~x~3~y~11~rx~2~ry~2|path~d~M7 11V7a5 5 0 0 1 10 0v4',
  'search': 'circle~cx~11~cy~11~r~8|path~d~m21 21-4.3-4.3',
  'user-round': 'circle~cx~12~cy~8~r~5|path~d~M20 21a8 8 0 0 0-16 0',
  'pencil': 'path~d~M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z|path~d~m15 5 4 4',
  'ear': 'path~d~M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0|path~d~M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4',
  'palette': 'circle~cx~13.5~cy~6.5~r~.5~fill~currentColor|circle~cx~17.5~cy~10.5~r~.5~fill~currentColor|circle~cx~8.5~cy~7.5~r~.5~fill~currentColor|circle~cx~6.5~cy~12.5~r~.5~fill~currentColor|path~d~M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z',
  'puzzle': 'path~d~M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z',
} as const

// The kay mark, the kingfisher without the favicon's tile, on the 54 by 52 box its drawing fills; its beak and eye take the colour of the text around it.
export const MARK = 'path~fill~#1f8fd1~d~M21.5 16A9 9 0 0 1 38.5 16L46.1 25.2L55.3 50.2L48.7 47.4L48.7 54.6L29.4 36.2L24 25.7A9 9 0 0 1 22 22.5Z|path~fill~#1670a8~d~M39.8 22.1L46.1 25.2L55.3 50.2L48.7 47.4L40.5 31.3Z|path~fill~#ef7d2a~d~M22 22.5A9 9 0 0 0 24 25.7L29.4 36.2L48.7 54.6L48.7 47.4L36.3 34L29.1 26.8ZM20 18.4L35.5 19.5L20.5 21.2Z|path~fill~currentColor~d~M21.5 16L17.7 19.5L6.7 26.9L18.8 22.7L22 22.5L25.2 19.4Z|circle~cx~36.5~cy~21.5~r~1.6~fill~#eef2f7|circle~cx~27~cy~16~r~1.5~fill~currentColor'

// The name of an icon a tab or a button can wear.
export type DevIconName = keyof typeof ICONS
// What a tab without an icon wears.
export const DEFAULT_ICON: DevIconName = 'puzzle'

// A drawing from its nodes, hidden from screen readers: the control it sits in is named.
export function drawing(doc: Document, nodes: string, viewBox: string, className: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG, 'svg')

  svg.setAttribute('viewBox', viewBox)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', className)

  for (const node of nodes.split('|')) {
    const [tag, ...attributes] = node.split('~')
    const element = doc.createElementNS(SVG, tag!)

    for (let index = 0; index < attributes.length; index += 2)
      element.setAttribute(attributes[index]!, attributes[index + 1]!)

    svg.append(element)
  }

  return svg
}

export function iconOf(doc: Document, name: string): SVGSVGElement {
  return drawing(doc, ICONS[name as DevIconName] ?? ICONS[DEFAULT_ICON], '0 0 24 24', 'i')
}

// An icon button: the drawing with its name for screen readers and as the native tooltip.
export function setIcon(button: HTMLButtonElement, label: string, name: DevIconName): void {
  button.replaceChildren(iconOf(button.ownerDocument, name))
  button.title = label
  button.setAttribute('aria-label', label)
}

// The icon a count's tone puts in the bar's badge.
export const TONE_ICONS = { error: 'circle-x', warn: 'triangle-alert' } as const satisfies Record<'error' | 'warn', DevIconName>
