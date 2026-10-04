import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtworkStore, CallObserver } from '../agents/ports.js';
import type { AppConfig } from '../config.js';

/**
 * Client for the external MCP filesystem server
 * (@modelcontextprotocol/server-filesystem, which this project does not
 * write). In production each instance runs in its own container behind an
 * HTTP bridge; in local development it is started over stdio.
 */
export type McpEndpoint = { url: string } | { command: string; args: string[] };

export class McpFilesystem {
  private client?: Client;
  /** Every tool the server offers, as discovered with tools/list. */
  serverTools: string[] = [];

  constructor(
    readonly name: string,
    private readonly endpoint: McpEndpoint,
    /** The only tools this client will ever call, whatever the server offers. */
    readonly allowedTools: readonly string[],
    private readonly timeoutMs = 15_000,
  ) {}

  async connect(): Promise<this> {
    const client = new Client({ name: `prepress-${this.name}`, version: '1.0.0' });
    const transport =
      'url' in this.endpoint
        ? new StreamableHTTPClientTransport(new URL(this.endpoint.url))
        : new StdioClientTransport({ command: this.endpoint.command, args: this.endpoint.args, stderr: 'ignore' });
    await client.connect(transport);
    this.serverTools = (await client.listTools()).tools.map((t) => t.name);
    const missing = this.allowedTools.filter((t) => !this.serverTools.includes(t));
    if (missing.length) {
      await client.close();
      throw new Error(`MCP server "${this.name}" does not offer ${missing.join(', ')}`);
    }
    this.client = client;
    return this;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }

  /**
   * Calls one MCP tool. Refuses tools outside the allowlist before anything
   * reaches the server, reconnects once if the server restarted, and turns
   * an MCP error result into an exception.
   */
  async call(tool: string, args: Record<string, unknown>): Promise<{ content: unknown[] }> {
    if (!this.allowedTools.includes(tool)) {
      throw new Error(`MCP tool "${tool}" is not allowed on "${this.name}" (allowed: ${this.allowedTools.join(', ')})`);
    }
    const attempt = async () => {
      if (!this.client) await this.connect();
      return this.client!.callTool({ name: tool, arguments: args }, undefined, { timeout: this.timeoutMs });
    };
    let result;
    try {
      result = await attempt();
    } catch {
      await this.close().catch(() => {});
      result = await attempt(); // one reconnect, e.g. after a sidecar restart
    }
    const content = (result.content ?? []) as { type: string; text?: string }[];
    if (result.isError) throw new Error(content.map((c) => c.text ?? '').join(' ') || `${tool} failed`);
    return { content };
  }
}

const JOB_ID = /^[a-z0-9-]{4,64}$/;

/**
 * ArtworkStore backed by two instances of the external MCP filesystem server:
 * one that can only see the artwork folder (mounted read-only, and this
 * client may only call read_media_file) and one that can only see the
 * reports folder (this client may only call write_file).
 */
export class McpArtworkStore implements ArtworkStore {
  constructor(
    private readonly artwork: McpFilesystem,
    private readonly reports: McpFilesystem,
    /** Folder paths as the servers see them (inside their containers). */
    private readonly roots: { artwork: string; reports: string },
  ) {}

  private async timed<T>(fs: McpFilesystem, tool: string, path: string, observe: CallObserver | undefined, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const out = await run();
      observe?.({ server: fs.name, tool, path, durationMs: Date.now() - started, ok: true });
      return out;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      observe?.({ server: fs.name, tool, path, durationMs: Date.now() - started, ok: false, error });
      throw err;
    }
  }

  async readArtwork(jobId: string, observe?: CallObserver): Promise<Buffer> {
    if (!JOB_ID.test(jobId)) throw new Error(`invalid job id "${jobId}"`);
    const path = `${this.roots.artwork}/${jobId}.img`;
    return this.timed(this.artwork, 'read_media_file', path, observe, async () => {
      const { content } = await this.artwork.call('read_media_file', { path });
      const block = content[0] as { type: string; data?: string; resource?: { blob?: string } } | undefined;
      const base64 = block?.data ?? block?.resource?.blob;
      if (!base64) throw new Error('MCP server returned no file content');
      return Buffer.from(base64, 'base64');
    });
  }

  async saveReport(jobId: string, markdown: string, observe?: CallObserver): Promise<string> {
    if (!JOB_ID.test(jobId)) throw new Error(`invalid job id "${jobId}"`);
    const path = `${this.roots.reports}/${jobId}.md`;
    await this.timed(this.reports, 'write_file', path, observe, () => this.reports.call('write_file', { path, content: markdown }));
    return `reports/${jobId}.md`;
  }

  async close(): Promise<void> {
    await Promise.all([this.artwork.close(), this.reports.close()]);
  }
}

/** Starts the filesystem server over stdio (local development and tests). */
export function stdioFilesystemServer(dir: string): McpEndpoint {
  let entry: string;
  try {
    entry = fileURLToPath(import.meta.resolve('@modelcontextprotocol/server-filesystem/dist/index.js'));
  } catch {
    throw new Error('MCP_ARTWORK_URL is not set and @modelcontextprotocol/server-filesystem is not installed (npm install)');
  }
  return { command: process.execPath, args: [entry, dir] };
}

/**
 * Connects to both MCP servers. Production: the sidecar URLs. Local: two
 * stdio servers rooted at DATA_DIR/artwork and DATA_DIR/reports.
 */
export async function createMcpArtworkStore(config: AppConfig): Promise<McpArtworkStore> {
  let artworkEndpoint: McpEndpoint;
  let reportsEndpoint: McpEndpoint;
  let roots: { artwork: string; reports: string };
  if (config.MCP_ARTWORK_URL && config.MCP_REPORTS_URL) {
    artworkEndpoint = { url: config.MCP_ARTWORK_URL };
    reportsEndpoint = { url: config.MCP_REPORTS_URL };
    roots = { artwork: config.MCP_ARTWORK_ROOT, reports: config.MCP_REPORTS_ROOT };
  } else {
    roots = { artwork: resolve(join(config.DATA_DIR, 'artwork')), reports: resolve(join(config.DATA_DIR, 'reports')) };
    await mkdir(roots.artwork, { recursive: true });
    await mkdir(roots.reports, { recursive: true });
    artworkEndpoint = stdioFilesystemServer(roots.artwork);
    reportsEndpoint = stdioFilesystemServer(roots.reports);
  }
  const artwork = await new McpFilesystem('mcp-artwork', artworkEndpoint, ['read_media_file']).connect();
  const reports = await new McpFilesystem('mcp-reports', reportsEndpoint, ['write_file']).connect();
  return new McpArtworkStore(artwork, reports, roots);
}
