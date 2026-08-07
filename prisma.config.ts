import { config as loadEnv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// Mirrors ConfigModule's precedence elsewhere in the app: the NODE_ENV file
// wins, `.env` fills in whatever it omits. Prisma's own `import "dotenv/config"`
// pattern only loads a literal `.env`, which doesn't fit this project's
// per-environment file layout — so this loads them the same way
// src/database/check-connection.ts and prisma/seed.ts do.
const nodeEnv = process.env.NODE_ENV ?? 'local';
loadEnv({ path: `.env.${nodeEnv}` });
loadEnv({ path: '.env' });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // tsx, not ts-node: the generated client's internal modules import each
    // other with explicit ".js" extensions (NodeNext-style) that only exist
    // as ".ts" pre-build — tsx's esbuild-based loader resolves that; plain
    // ts-node's CJS require hook does not.
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
