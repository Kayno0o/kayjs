import { bundled } from '../../playground/bundle'

// No network, nothing but the page's own script: the frame holds code a visitor typed. `unsafe-eval` is for `new Function` and is on this document alone, the site's policy being the docs' own; `frame-ancestors` lets the docs' pages frame it and nobody else.
const POLICY = 'default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\'; style-src \'unsafe-inline\'; frame-ancestors \'self\'; base-uri \'none\'; form-action \'none\''
const CLOSING_SCRIPT = /<\/script/gi

const runtime = bundled('frame.ts', false)

// The document the playground shows a component in, framed by the page with `sandbox="allow-scripts"`.
export async function GET() {
  const script = (await runtime()).text.replace(CLOSING_SCRIPT, '<\\/script')

  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Playground</title><meta name="color-scheme" content="light dark"><style>body{margin:0;padding:1rem;font:16px/1.5 system-ui,sans-serif}</style><body><div id="root"></div><script type="module">${script}</script>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': POLICY, 'cache-control': 'no-cache' } })
}
