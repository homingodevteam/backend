import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { buildS3Options } from '../config/s3.config';

const UPLOAD_URL_TTL_SECONDS = 5 * 60;
const VIEW_URL_TTL_SECONDS = 5 * 60;

/**
 * Generic presigned-URL helper — not KYC-specific. The client PUTs directly
 * to S3 with the URL from createUploadUrl(); the platform never proxies the
 * file bytes. Objects are private (no bucket ACL grants); every read goes
 * through createViewUrl(), which callers are expected to audit-log
 * (KycDocumentsService does, for the one consumer that exists today).
 */
@Injectable()
export class S3Service {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    const options = buildS3Options({
      NODE_ENV: config.get<string>('NODE_ENV'),
      AWS_REGION: config.get<string>('AWS_REGION'),
      AWS_S3_BUCKET: config.get<string>('AWS_S3_BUCKET'),
      AWS_ACCESS_KEY_ID: config.get<string>('AWS_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: config.get<string>('AWS_SECRET_ACCESS_KEY'),
    });

    this.bucket = options.bucket;
    this.client = new S3Client({
      region: options.region,
      // Omitting credentials entirely lets the SDK fall through to its
      // default provider chain — an EC2 instance role in production.
      ...(options.accessKeyId && options.secretAccessKey
        ? {
            credentials: {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey,
            },
          }
        : {}),
    });
  }

  /** Builds a fresh key under `prefix` and a short-lived presigned PUT URL for it. */
  async createUploadUrl(
    prefix: string,
    contentType: string,
  ): Promise<{ key: string; uploadUrl: string; expiresIn: number }> {
    const key = `${prefix}/${randomUUID()}`;

    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    );

    return { key, uploadUrl, expiresIn: UPLOAD_URL_TTL_SECONDS };
  }

  /** Short-lived presigned GET — the only way anything ever reads a private object. */
  async createViewUrl(
    key: string,
  ): Promise<{ viewUrl: string; expiresIn: number }> {
    const viewUrl = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: VIEW_URL_TTL_SECONDS },
    );

    return { viewUrl, expiresIn: VIEW_URL_TTL_SECONDS };
  }
}
