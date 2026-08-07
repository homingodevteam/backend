type Env = Record<string, string | undefined>;

function str(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export interface S3Options {
  region: string;
  bucket: string;
  /** Undefined on both = fall back to the SDK's default credential chain
   *  (an EC2 instance role, in production). Local dev needs both set. */
  accessKeyId?: string;
  secretAccessKey?: string;
}

export function buildS3Options(env: Env = process.env): S3Options {
  const region = str(env.AWS_REGION);
  const bucket = str(env.AWS_S3_BUCKET);

  if (!region || !bucket) {
    throw new Error(
      `S3 is not configured. Set AWS_REGION and AWS_S3_BUCKET in .env.${env.NODE_ENV ?? 'local'}.`,
    );
  }

  return {
    region,
    bucket,
    accessKeyId: str(env.AWS_ACCESS_KEY_ID),
    secretAccessKey: str(env.AWS_SECRET_ACCESS_KEY),
  };
}
