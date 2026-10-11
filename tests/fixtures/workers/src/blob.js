// As qr-scanner ships: a chunk loaded on demand starts its worker from a blob.
export function timesSeven(n) {
  const worker = new Worker(URL.createObjectURL(new Blob(['onmessage = event => postMessage(event.data * 7)'], { type: 'text/javascript' })))

  return new Promise((resolve) => {
    worker.onmessage = event => resolve(event.data)
    worker.postMessage(n)
  })
}
