import { z } from 'zod';

/** Runtime configuration from environment variables (see .env.example). */
const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
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
  /** "cognito" verifies real tokens; "dev" accepts any request as a local user (never in production). */
  AUTH_MODE: z.enum(['cognito', 'dev']).default('cognito'),
  COGNITO_REGION: z.string().optional(),
  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_CLIENT_ID: z.string().optional(),
  COGNITO_REQUIRED_GROUP: z.string().default('prepress-reviewers'),
  CORS_ORIGINS: z.string().default('https://prepress.gemsofy.com,http://localhost:5173'),
  /** Reviews each user may start per 10 minutes (each costs model calls). */
  RATE_LIMIT_PER_10_MIN: z.coerce.number().int().positive().default(10),
  MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(2),
  SAMPLES_DIR: z.string().optional(),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = EnvSchema.parse(env);
  if (config.AUTH_MODE === 'dev' && config.NODE_ENV === 'production') {
    throw new Error('AUTH_MODE=dev is not allowed in production');
  }
  if (config.AUTH_MODE === 'cognito' && config.NODE_ENV === 'production' && !(config.COGNITO_USER_POOL_ID && config.COGNITO_CLIENT_ID)) {
    throw new Error('COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID are required in production');
  }
  return config;
}
