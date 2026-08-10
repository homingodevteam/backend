import { readFileSync } from 'node:fs';
import {
  cert,
  initializeApp,
  type App,
  type ServiceAccount,
} from 'firebase-admin/app';

let app: App | undefined;

/**
 * Initializes the firebase-admin SDK once from a service-account key file.
 * Callable both as a Nest provider factory and standalone from
 * prisma/seed.ts, which runs outside Nest DI (same reason PrismaClient is
 * constructed directly there instead of via PrismaService).
 */
export function initFirebaseAdmin(serviceAccountPath: string): App {
  if (app) return app;

  const serviceAccount = JSON.parse(
    readFileSync(serviceAccountPath, 'utf8'),
  ) as ServiceAccount;

  app = initializeApp({ credential: cert(serviceAccount) });
  return app;
}
