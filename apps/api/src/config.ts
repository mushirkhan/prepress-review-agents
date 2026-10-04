import { z } from 'zod';

/** Runtime configuration from environment variables (see .env.example). */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATA_DIR: z.string().default('./data'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(204_800),
  AWS_REGION: z.string().default('us-east-1'),
  BEDROCK_ORCHESTRATOR_MODEL: z.string().default('amazon.nova-lite-v1:0'),
  BEDROCK_SPECIALIST_MODEL: z.string().default('amazon.nova-micro-v1:0'),
  BEDROCK_VISION_MODEL: z.string().default('amazon.nova-lite-v1:0'),
  BEDROCK_EMBEDDING_MODEL: z.string().default('amazon.titan-embed-text-v2:0'),
  /**
   * External MCP filesystem servers. In production these are the two sidecar
   * containers; when unset (local development) the server is started over stdio.
   */
  MCP_ARTWORK_URL: z.string().url().optional(),
  MCP_REPORTS_URL: z.string().url().optional(),
  /** Folder paths as the MCP servers see them. */
  MCP_ARTWORK_ROOT: z.string().default('/data/artwork'),
  MCP_REPORTS_ROOT: z.string().default('/data/reports'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvSchema.parse(env);
}
