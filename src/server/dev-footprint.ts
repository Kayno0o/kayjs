import { ECOINDEX_VERSION, figuresOf, SWD_VERSION } from '../build/footprint-models'
import { isCrossSite } from './actions'

const HEADER = 'x-kay-dev'
const NUMBER = /^\d{1,12}(?:\.\d{1,6})?$/

// What the dev tool's Performance tab shows of a page it measured in the browser: the EcoIndex score and grade and the carbon of a view, worked out by the same models `kay build` uses, so the two never differ in the constants. Only the three counts are read, from the dev tool.
export function devFootprint(request: Request): Response {
  if (request.headers.get(HEADER) === null || isCrossSite(request))
    return new Response(null, { status: 403 })

  const query = new URL(request.url).searchParams
  const [dom = '', requests = '', bytes = ''] = ['dom', 'requests', 'bytes'].map(name => query.get(name) ?? '')

  if (![dom, requests, bytes].every(value => NUMBER.test(value)))
    return new Response(null, { status: 400 })

  return Response.json({ ...figuresOf({ dom: Number(dom), requests: Number(requests), bytes: Number(bytes) }), ecoindex: ECOINDEX_VERSION, swd: SWD_VERSION })
}
