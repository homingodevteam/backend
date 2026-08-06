import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import { buildDatabaseOptions } from '../config/database.config';

// The TypeORM CLI runs outside Nest, so nothing has loaded the env files yet.
// Mirror ConfigModule's order: the NODE_ENV-specific file first, then `.env`
// as the fallback. dotenv does not overwrite already-set keys, so the first
// file to define a variable wins — same precedence the app sees.
const nodeEnv = process.env.NODE_ENV ?? 'local';
loadEnv({ path: `.env.${nodeEnv}` });
loadEnv({ path: '.env' });

/**
 * Used only by the TypeORM CLI (`npm run migration:generate|run|revert`).
 * The running app builds its own connection in DatabaseModule — both call
 * buildDatabaseOptions, so they always agree.
 */
export default new DataSource(buildDatabaseOptions());
