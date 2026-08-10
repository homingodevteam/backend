type Env = Record<string, string | undefined>;

function str(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export interface FirebaseOptions {
  /** Path to the downloaded service-account JSON key. Never committed. */
  serviceAccountPath: string;
}

export function buildFirebaseOptions(env: Env = process.env): FirebaseOptions {
  const serviceAccountPath = str(env.FIREBASE_SERVICE_ACCOUNT_PATH);
  if (!serviceAccountPath) {
    throw new Error(
      `Firebase is not configured. Set FIREBASE_SERVICE_ACCOUNT_PATH in .env.${env.NODE_ENV ?? 'local'}.`,
    );
  }
  return { serviceAccountPath };
}
