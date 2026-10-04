import { describe, expect, it } from 'vitest';
import { SseParser } from '../src/lib/sse';

describe('SseParser', () => {
  it('parses events split across network chunks', () => {
    const p = new SseParser();
    expect(p.push('id: 1\nevent: trace\nda')).toEqual([]);
    expect(p.push('ta: {"seq":1}\n\nevent: ping\ndata: \n\n')).toEqual([
      { event: 'trace', data: '{"seq":1}', id: '1' },
      { event: 'ping', data: '' },
    ]);
  });

  it('handles CRLF line endings, comments and multi-line data', () => {
    const p = new SseParser();
    expect(p.push(': keep-alive\r\n\r\nevent: end\r\ndata: a\r\ndata: b\r\n\r\n')).toEqual([{ event: 'end', data: 'a\nb' }]);
  });
});
