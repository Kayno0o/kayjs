// What a browser lacking invoker commands (Safari before 26.2), `closedby` (Safari before 27.3) or anchor positioning (Safari before 26, Firefox before 147) needs for the static Dialog and Drawer, `commandfor` buttons and the Menu, Select and Popover popups: only that browser loads it.

// Below the trigger, or above it and right-aligned where the viewport has no room, as `position-try-fallbacks` would; again on scroll, as an anchor would follow.
const PLACE_POPUP = 'const S=["[data-ui=menu] [role=menu]","[data-ui=select] [role=listbox]","[data-ui=popover][popover]"],'
  + 'P=t=>{const b=t.closest("[data-ui=menu],[data-ui=select]")?.querySelector("[data-part=trigger]")??document.querySelector(`[popovertarget="${t.id}"]`);if(!b)return;'
  + 'const r=b.getBoundingClientRect(),h=t.offsetHeight,w=t.offsetWidth,y=r.bottom+4+h>innerHeight&&r.top-4-h>=0?r.top-4-h:r.bottom+4,x=r.left+w>innerWidth?Math.max(0,r.right-w):r.left;'
  + 'Object.assign(t.style,{positionArea:"none",positionTryFallbacks:"none",margin:"0",inset:`${y}px auto auto ${x}px`,minWidth:t.matches("[data-ui=popover]")?"":`${r.width}px`})};'
  + 'A&&(document.addEventListener("toggle",e=>e.newState==="open"&&e.target.matches(S.join())&&P(e.target),true),'
  + 'addEventListener("scroll",()=>document.querySelectorAll(S.map(s=>`${s}:popover-open`).join()).forEach(P),{capture:true,passive:true}));'

/** Opens and closes what a `commandfor` button names, closes a `closedby="any"` dialog on a click pressed and released on its backdrop, and places the popups against their trigger. */
export const FALLBACK_JS = 'const C=!("command"in HTMLButtonElement.prototype),B=!("closedBy"in HTMLDialogElement.prototype),A=!CSS.supports("position-area:block-end");let D;'
  + PLACE_POPUP
  + 'document.addEventListener("pointerdown",e=>D=e.target,true);'
  + 'document.addEventListener("click",e=>{const t=e.target;'
  + 'if(C){const b=t.closest&&t.closest("button[commandfor]"),d=b&&document.getElementById(b.getAttribute("commandfor"));'
  + 'if(d){const c=b.getAttribute("command");c==="show-modal"?d.open||d.showModal():c==="close"||c==="request-close"?d.close():c==="toggle-popover"?d.togglePopover():c==="show-popover"?d.showPopover():c==="hide-popover"&&d.hidePopover();return}}'
  + 'if(B&&t===D&&t instanceof HTMLDialogElement&&t.open&&t.getAttribute("closedby")==="any"){const r=t.getBoundingClientRect();'
  + '(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)&&t.close()}})'

/** The fallback's file under the asset prefix, named by its content so a browser keeps it for good. */
export const FALLBACK_FILE = `kui-fallback-${new Bun.CryptoHasher('sha256').update(FALLBACK_JS).digest('hex').slice(0, 8)}.js`

/** Inline on a page with a `commandfor` button or a popup: imports the fallback only where a feature is missing, so other browsers fetch nothing. */
export const FALLBACK_GUARD = 'if(!("command"in HTMLButtonElement.prototype&&"closedBy"in HTMLDialogElement.prototype&&CSS.supports("position-area:block-end")))import(document.querySelector("script[data-kui-fallback]").dataset.kuiFallback)'

const NEEDS_FALLBACK_RE = /<button\b[^>]*\scommandfor=|\sdata-ui="(?:menu|select|popover)"/

/** `html` with the guard before `</head>` when a button in it carries `commandfor` or it holds a Menu, Select or Popover, pointing at the fallback under `assetPrefix`. */
export function withPlatformFallback(html: string, assetPrefix: string): string {
  if (!NEEDS_FALLBACK_RE.test(html) || html.includes('data-kui-fallback'))
    return html
  const tag = `<script type="module" data-kui-fallback="${assetPrefix.replace(/\/$/, '')}/${FALLBACK_FILE}">${FALLBACK_GUARD}</script>`
  const head = html.indexOf('</head>')
  return head === -1 ? `${tag}${html}` : `${html.slice(0, head)}${tag}${html.slice(head)}`
}
