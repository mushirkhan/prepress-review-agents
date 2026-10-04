/**
 * Boundaries between the agents and the outside world. The agents depend on
 * these interfaces only, so tests swap in fakes and the deployment wires in
 * the real implementations (the external MCP filesystem server and Bedrock).
 */

/** One call to an external service made on behalf of a tool, for the trace. */
export interface ExternalCall {
  server: string;
  tool: string;
  path?: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export type CallObserver = (call: ExternalCall) => void;

/** Where artwork is read from and reports are written to. */
export interface ArtworkStore {
  /** Reads the artwork for a job. The store, not the model, resolves the path. */
  readArtwork(jobId: string, observe?: CallObserver): Promise<Buffer>;
  /** Writes the report for a job and returns where it was saved. */
  saveReport(jobId: string, markdown: string, observe?: CallObserver): Promise<string>;
}

export interface VisionResult {
  /** Text visible on the artwork, one entry per line or block. */
  texts: string[];
  /** Plain-language descriptions of any logos or brand symbols seen. */
  logos: string[];
}

/** Reads text and describes logos on an image (Nova Lite in production). */
export interface VisionReader {
  describe(image: Buffer): Promise<VisionResult>;
}

/** Turns text into vectors for semantic matching (Titan in production). */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}
