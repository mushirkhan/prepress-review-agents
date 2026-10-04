/**
 * Integration tests against the real external MCP filesystem server
 * (@modelcontextprotocol/server-filesystem), started over stdio with
 * temporary folders. No mocks: these prove the protocol round trip and that
 * the server, not just our code, enforces the folder boundaries.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpArtworkStore, McpFilesystem, stdioFilesystemServer } from '../../src/adapters/mcp.js';
import type { ExternalCall } from '../../src/agents/ports.js';
import { SAMPLES_DIR } from '../helpers/fakes.js';

let dirs: { artwork: string; reports: string };
let artwork: McpFilesystem;
let reports: McpFilesystem;
let store: McpArtworkStore;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-'));
  dirs = { artwork: join(root, 'artwork'), reports: join(root, 'reports') };
  await mkdir(dirs.artwork);
  await mkdir(dirs.reports);
  artwork = await new McpFilesystem('mcp-artwork', stdioFilesystemServer(dirs.artwork), ['read_media_file']).connect();
  reports = await new McpFilesystem('mcp-reports', stdioFilesystemServer(dirs.reports), ['write_file']).connect();
  store = new McpArtworkStore(artwork, reports, dirs);
}, 30_000);

afterAll(async () => {
  await store?.close();
});

describe('external MCP filesystem server', () => {
  it('discovers the server tools with tools/list; the client uses only one per server', () => {
    expect(artwork.serverTools.length).toBeGreaterThanOrEqual(10);
    expect(artwork.serverTools).toEqual(expect.arrayContaining(['read_media_file', 'write_file', 'move_file', 'edit_file']));
    expect(artwork.allowedTools).toEqual(['read_media_file']);
    expect(reports.allowedTools).toEqual(['write_file']);
  });

  it('reads artwork byte-for-byte through read_media_file and reports the call', async () => {
    const original = await readFile(join(SAMPLES_DIR, 'approve/business-card-clean.jpg'));
    await writeFile(join(dirs.artwork, 'job-1234.img'), original);
    const calls: ExternalCall[] = [];
    const read = await store.readArtwork('job-1234', (c) => calls.push(c));
    expect(read.equals(original)).toBe(true);
    expect(calls).toEqual([expect.objectContaining({ server: 'mcp-artwork', tool: 'read_media_file', ok: true })]);
  });

  it('writes reports through write_file into the reports folder only', async () => {
    expect(await store.saveReport('job-1234', '# Report')).toBe('reports/job-1234.md');
    expect(await readFile(join(dirs.reports, 'job-1234.md'), 'utf8')).toBe('# Report');
  });

  it('client allowlist: the artwork connection refuses to call write_file at all', async () => {
    await expect(artwork.call('write_file', { path: join(dirs.artwork, 'x.txt'), content: 'x' })).rejects.toThrow(/not allowed/);
  });

  it('server boundary: the reports server refuses paths outside its folder', async () => {
    await expect(reports.call('write_file', { path: join(dirs.artwork, 'job-1234.img'), content: 'overwritten' })).rejects.toThrow(
      /Access denied|outside allowed/,
    );
    await expect(artwork.call('read_media_file', { path: '/etc/passwd' })).rejects.toThrow(/Access denied|outside allowed/);
  });

  it('store refuses job ids that could build a path outside the folder', async () => {
    await expect(store.readArtwork('../../etc/passwd')).rejects.toThrow(/invalid job id/);
  });

  it('reports a missing file as a failed call', async () => {
    const calls: ExternalCall[] = [];
    await expect(store.readArtwork('job-missing', (c) => calls.push(c))).rejects.toThrow();
    expect(calls[0]).toMatchObject({ ok: false, tool: 'read_media_file' });
  });
});
