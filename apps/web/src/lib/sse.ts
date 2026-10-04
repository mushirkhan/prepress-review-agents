import type { TraceEvent } from '../types';

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental Server-Sent Events parser. EventSource cannot send an
 * Authorization header, so the stream is read with fetch and parsed here.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const out: SseMessage[] = [];
    let end: number;
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const msg: SseMessage = { event: 'message', data: '' };
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const i = line.indexOf(':');
        const field = i < 0 ? line : line.slice(0, i);
        const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
        if (field === 'event') msg.event = value;
        else if (field === 'data') data.push(value);
        else if (field === 'id') msg.id = value;
      }
      msg.data = data.join('\n');
      if (data.length || msg.event !== 'message') out.push(msg);
    }
    return out;
  }
}

export interface StreamHandlers {
  onEvent: (e: TraceEvent) => void;
  onEnd: (final: { status?: string; verdict?: string }) => void;
}

/**
 * Follows a job's live trace. Reconnects after a dropped connection with
 * Last-Event-ID, so no event is missed or repeated; gives up after a few
 * failed attempts (the page then falls back to polling).
 */
export async function followEvents(url: string, getToken: () => Promise<string | undefined>, handlers: StreamHandlers, signal: AbortSignal): Promise<void> {
  let lastId = 0;
  for (let attempt = 0; attempt < 5 && !signal.aborted; attempt++) {
    try {
      const token = await getToken();
      const res = await fetch(url, {
        signal,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(lastId ? { 'Last-Event-ID': String(lastId) } : {}) },
      });
      if (!res.ok || !res.body) throw new Error(`stream failed (${res.status})`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      const parser = new SseParser();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const msg of parser.push(value)) {
          if (msg.event === 'trace') {
            const e = JSON.parse(msg.data) as TraceEvent;
            lastId = e.seq;
            handlers.onEvent(e);
          } else if (msg.event === 'end') {
            handlers.onEnd(JSON.parse(msg.data) as { status?: string; verdict?: string });
            return;
          }
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      console.warn('live trace interrupted, reconnecting', err);
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}
