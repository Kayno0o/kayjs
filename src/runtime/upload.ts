const NULL_BODY = new Set([204, 205, 304])
const HEADER_LINE = /\r?\n/

// Sends a form as fetch would, through an XMLHttpRequest, which tells how much of it went: rejecting as fetch does on a network error (with `sent` true once the whole body had gone or an answer had begun), and with the signal's reason once it aborts.
export async function uploaded(method: string, url: string, headers: Record<string, string>, body: FormData | URLSearchParams, onProgress: (sent: number) => void, signal?: AbortSignal): Promise<Response> {
  signal?.throwIfAborted()

  const request = new XMLHttpRequest()
  let sent = false
  let answered = false
  const abort = () => request.abort()

  request.open(method, url)
  request.responseType = 'blob'

  for (const [name, value] of Object.entries(headers))
    request.setRequestHeader(name, value)

  request.upload.onload = () => sent = true
  request.onreadystatechange = () => answered ||= request.readyState === XMLHttpRequest.HEADERS_RECEIVED
  request.upload.onprogress = event => event.lengthComputable && onProgress(event.loaded / event.total)
  signal?.addEventListener('abort', abort, { once: true })

  try {
    return await new Promise((resolve, reject) => {
      request.onload = () => resolve(new Response(NULL_BODY.has(request.status) ? null : request.response as Blob, { status: request.status, headers: responseHeaders(request.getAllResponseHeaders()) }))
      request.onerror = () => reject(Object.assign(new TypeError('Failed to fetch'), { sent: sent || answered }))
      request.ontimeout = request.onerror
      request.onabort = () => reject(signal?.reason ?? new DOMException('The upload was aborted', 'AbortError'))
      request.send(body)
    })
  }
  finally {
    signal?.removeEventListener('abort', abort)
  }
}

function responseHeaders(text: string): Headers {
  const headers = new Headers()

  for (const line of text.trim().split(HEADER_LINE)) {
    const colon = line.indexOf(':')

    if (colon > 0)
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }

  return headers
}
