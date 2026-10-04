import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BedrockVision, parseVisionResponse } from '../../src/adapters/bedrock.js';
import { LocalArtworkStore } from '../../src/adapters/localStore.js';
import { loadConfig } from '../../src/config.js';
import { makeImage } from '../helpers/images.js';

describe('parseVisionResponse', () => {
  it('extracts JSON even when the model wraps it in prose or code fences', () => {
    expect(parseVisionResponse('Here you go:\n```json\n{"texts":["NIKE Air"," 50% off "],"logos":[]}\n```')).toEqual({
      texts: ['NIKE Air', '50% off'],
      logos: [],
    });
  });

  it('defaults missing arrays and rejects non-JSON answers', () => {
    expect(parseVisionResponse('{"texts":["a"]}')).toEqual({ texts: ['a'], logos: [] });
    expect(() => parseVisionResponse('I cannot see any text.')).toThrow(/did not return JSON/);
  });
});

describe('BedrockVision', () => {
  const config = loadConfig({});
  const image = () => makeImage({ widthMm: 50, heightMm: 30, cmyk: true });

  it('sends an sRGB JPEG copy and parses the answer', async () => {
    const sent: unknown[] = [];
    const client = {
      send: async (cmd: { input: unknown }) => {
        sent.push(cmd.input);
        return { output: { message: { content: [{ text: '{"texts":["Kettle & Leaf"],"logos":["green leaf"]}' }] } } };
      },
    };
    const v = new BedrockVision(config, client as never);
    expect(await v.describe(await image())).toEqual({ texts: ['Kettle & Leaf'], logos: ['green leaf'] });
    expect(JSON.stringify(sent[0])).toContain('"format":"jpeg"');
  });

  it('retries once when the model returns malformed output, then fails', async () => {
    let calls = 0;
    const client = { send: async () => (calls++, { output: { message: { content: [{ text: 'no json here' }] } } }) };
    await expect(new BedrockVision(config, client as never).describe(await image())).rejects.toThrow(/did not return JSON/);
    expect(calls).toBe(2);
  });
});

describe('LocalArtworkStore', () => {
  it('saves and reads by job id, and refuses ids that could escape the folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'store-'));
    const store = new LocalArtworkStore(dir);
    await store.saveArtwork('job-1234', Buffer.from('img'));
    expect((await store.readArtwork('job-1234')).toString()).toBe('img');
    expect(await store.saveReport('job-1234', '# r')).toBe('reports/job-1234.md');
    expect(await readFile(join(dir, 'reports/job-1234.md'), 'utf8')).toBe('# r');
    await expect(store.readArtwork('../../etc/passwd')).rejects.toThrow(/invalid job id/);
  });
});
