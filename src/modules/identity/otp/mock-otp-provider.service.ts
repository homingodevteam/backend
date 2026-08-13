import { randomInt, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../../redis/redis.service';
import { OtpProvider, OtpSendResult } from './otp-provider.interface';

interface StoredOtp {
  code: string;
  providerRef: string;
  attempts: number;
}

const MAX_VERIFY_ATTEMPTS = 5;

/**
 * Local/dev stand-in for MSG91 / Synquic Slide. Generates a code, stores it
 * in Redis (self-expiring — matches the "no OTP table" ground rule) and
 * logs it instead of sending an SMS. One-time use: a successful verify
 * deletes the key, so the same code can't be replayed.
 */
@Injectable()
export class MockOtpProvider implements OtpProvider {
  private readonly logger = new Logger(MockOtpProvider.name);

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async sendOtp(phone: string): Promise<OtpSendResult> {
    const length = Number(this.config.get<string>('OTP_LENGTH', '6'));
    const ttlSeconds = Number(
      this.config.get<string>('OTP_TTL_SECONDS', '300'),
    );

    const configuredCode = this.config.get<string>('MOCK_OTP_CODE')?.trim();
    if (
      configuredCode &&
      !new RegExp(`^\\d{${length}}$`).test(configuredCode)
    ) {
      throw new Error(`MOCK_OTP_CODE must contain exactly ${length} digits`);
    }
    // Deterministic only when an isolated test explicitly asks for it. Normal
    // local development keeps random one-time codes, and production cannot
    // select the mock provider at all (enforced by slide.config).
    const code =
      configuredCode ??
      String(randomInt(0, 10 ** length)).padStart(length, '0');
    const providerRef = randomUUID();

    await this.redis.set(
      this.key(phone),
      JSON.stringify({ code, providerRef, attempts: 0 } satisfies StoredOtp),
      ttlSeconds,
    );

    this.logger.log(`[MOCK OTP] ${phone} -> ${code} (ref ${providerRef})`);

    return { providerRef };
  }

  async verifyOtp(
    phone: string,
    code: string,
    providerRef: string,
  ): Promise<boolean> {
    const raw = await this.redis.get(this.key(phone));
    if (!raw) return false;

    const stored = JSON.parse(raw) as StoredOtp;
    const isValid = stored.code === code && stored.providerRef === providerRef;

    if (isValid) {
      await this.redis.del(this.key(phone));
      return true;
    }

    // Wrong code: burn an attempt rather than the whole code, so a mistyped
    // digit doesn't force a fresh SMS — but cap it so the 6-digit space
    // can't be brute-forced within the OTP's TTL window.
    const attempts = stored.attempts + 1;
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await this.redis.del(this.key(phone));
    } else {
      const ttl = await this.redis.raw.ttl(this.key(phone));
      await this.redis.set(
        this.key(phone),
        JSON.stringify({ ...stored, attempts } satisfies StoredOtp),
        ttl > 0 ? ttl : undefined,
      );
    }

    return false;
  }

  private key(phone: string): string {
    return `otp:${phone}`;
  }
}
