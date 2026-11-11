import { ArchiveError, checkAbort } from './canvas.js';
// Native messaging host installed by nix/pdf-host.nix; runs LibreOffice locally.
export const HOST = 'edu.calpoly.canvas_archive_pdf';
const MISSING = 'The PDF converter is not installed. Add the LibreOffice helper (see README: PDF conversion), restart the browser, then retry.';
const toBase64 = bytes => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
// Sends the original to the helper, then returns the PDF as a stream.
// shortcut: the PDF reply is queued in memory without backpressure; fine for lecture-sized files.
export async function toPDF(stream, filename, signal, chromeAPI = globalThis.chrome) {
  if (!chromeAPI?.runtime?.connectNative) throw new ArchiveError(MISSING);
  const port = chromeAPI.runtime.connectNative(HOST);
  let output, failure = null, finished = false;
  const fail = error => { if (finished) return; finished = true; failure = error; output.error(error); };
  const result = new ReadableStream({ start(controller) { output = controller; }, cancel() { finished = true; port.disconnect(); } });
  port.onMessage.addListener(message => {
    if (finished) return;
    if (typeof message?.data === 'string') output.enqueue(fromBase64(message.data));
    else if (message?.done) { finished = true; output.close(); port.disconnect(); }
    else fail(new ArchiveError(`PDF conversion failed: ${message?.error || 'unexpected converter reply'}.`));
  });
  port.onDisconnect.addListener(() => fail(new ArchiveError(/not found|forbidden/i.test(chromeAPI.runtime.lastError?.message || '') ? MISSING : 'The PDF converter stopped unexpectedly.')));
  const reader = stream.getReader();
  try {
    port.postMessage({ name: filename });
    while (true) {
      checkAbort(signal);
      if (failure) throw failure;
      const chunk = await reader.read();
      if (chunk.done) break;
      port.postMessage({ data: toBase64(chunk.value instanceof Uint8Array ? chunk.value : new Uint8Array(chunk.value)) });
    }
    port.postMessage({ end: true });
    return result;
  } catch (error) {
    finished = true; port.disconnect(); await reader.cancel().catch(() => {});
    if (error.name === 'AbortError' || error instanceof ArchiveError) throw error;
    throw failure || new ArchiveError(MISSING);
  }
}
