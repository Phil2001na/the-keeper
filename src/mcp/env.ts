import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';

/**
 * Claude Desktop launches MCP servers with an arbitrary working directory, so a
 * bare `dotenv/config` (which reads ./.env relative to cwd) would find nothing.
 * Load the project's own .env by absolute path, derived from this file's URL.
 * Imported FIRST in server.ts so it runs before config.ts reads process.env.
 * dotenv doesn't override already-set vars, so real env still wins on Railway.
 */
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });
