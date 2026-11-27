// What a browser lacking invoker commands (Safari before 26.2) or `closedby` (Safari before 27.3) needs for the static Dialog, Drawer and `commandfor` buttons: only that browser loads it.

/** Opens and closes what a `commandfor` button names, and closes a `closedby="any"` dialog on a backdrop click. */
export const FALLBACK_JS = 'const C=!("command"in HTMLButtonElement.prototype),B=!("closedBy"in HTMLDialogElement.prototype);'
  + 'document.addEventListener("click",e=>{const t=e.target;'
  + 'if(C){const b=t.closest&&t.closest("button[commandfor]"),d=b&&document.getElementById(b.getAttribute("commandfor"));'
  + 'if(d){const c=b.getAttribute("command");c==="show-modal"?d.open||d.showModal():c==="close"||c==="request-close"?d.close():c==="toggle-popover"?d.togglePopover():c==="show-popover"?d.showPopover():c==="hide-popover"&&d.hidePopover();return}}'
  + 'if(B&&t instanceof HTMLDialogElement&&t.open&&t.getAttribute("closedby")==="any"){const r=t.getBoundingClientRect();'
  + '(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)&&t.close()}})'

/** The fallback's file under the asset prefix, named by its content so a browser keeps it for good. */
export const FALLBACK_FILE = `kui-fallback-${new Bun.CryptoHasher('sha256').update(FALLBACK_JS).digest('hex').slice(0, 8)}.js`

/** Inline on a page with a `commandfor` button: imports the fallback only where a feature is missing, so other browsers fetch nothing. */
export const FALLBACK_GUARD = 'if(!("command"in HTMLButtonElement.prototype&&"closedBy"in HTMLDialogElement.prototype))import(document.querySelector("script[data-kui-fallback]").dataset.kuiFallback)'

const COMMANDFOR_RE = /<button\b[^>]*\scommandfor=/

/** `html` with the guard before `</head>` when a button in it carries `commandfor`, pointing at the fallback under `assetPrefix`. */
export function withPlatformFallback(html: string, assetPrefix: string): string {
  if (!COMMANDFOR_RE.test(html) || html.includes('data-kui-fallback'))
    return html
  const tag = `<script type="module" data-kui-fallback="${assetPrefix.replace(/\/$/, '')}/${FALLBACK_FILE}">${FALLBACK_GUARD}</script>`
  const head = html.indexOf('</head>')
  return head === -1 ? `${tag}${html}` : `${html.slice(0, head)}${tag}${html.slice(head)}`
}
