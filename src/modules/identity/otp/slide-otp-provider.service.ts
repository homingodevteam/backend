import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  SlideAuthError,
  SlideClient,
  SlideError,
  SlideNotFoundError,
  SlideScopeError,
  SlideValidationError,
} from '@synquic/slide';
import { OtpProvider, OtpSendResult } from './otp-provider.interface';

export const SLIDE_CLIENT = Symbol('SLIDE_CLIENT');
export const SLIDE_WIDGET_ID = Symbol('SLIDE_WIDGET_ID');

/**
 * Production OTP provider. Slide owns code generation, delivery, expiry,
 * attempt limits and verification; Homingo stores no production OTP code.
 */
@Injectable()
export class SlideOtpProvider implements OtpProvider {
  private readonly logger = new Logger(SlideOtpProvider.name);

  constructor(
    @Inject(SLIDE_CLIENT) private readonly slide: SlideClient,
    @Inject(SLIDE_WIDGET_ID) private readonly widgetId: string,
  ) {}

  async sendOtp(phone: string): Promise<OtpSendResult> {
    try {
      const sent = await this.slide.otp.send({
        widgetId: this.widgetId,
        identifier: phone,
      });

      return { providerRef: sent.requestId };
    } catch (error) {
      throw this.mapSendError(error);
    }
  }

  async verifyOtp(
    phone: string,
    code: string,
    providerRef: string,
  ): Promise<boolean> {
    try {
      const verified = await this.slide.otp.verify({
        requestId: providerRef,
        otp: code,
      });
      const proof = await this.slide.otp.verifyToken({
        accessToken: verified.accessToken,
      });

      return proof.verified && this.samePhone(proof.identifier, phone);
    } catch (error) {
      if (
        error instanceof SlideValidationError ||
        error instanceof SlideNotFoundError
      ) {
        return false;
      }
      throw this.mapProviderError(error);
    }
  }

  private samePhone(left: string, right: string): boolean {
    return left.replace(/^\+/, '') === right.replace(/^\+/, '');
  }

  private mapSendError(error: unknown): Error {
    if (error instanceof SlideValidationError) {
      return new BadRequestException('OTP request was rejected');
    }
    return this.mapProviderError(error);
  }

  private mapProviderError(error: unknown): Error {
    if (error instanceof SlideAuthError || error instanceof SlideScopeError) {
      this.logger.error(`Slide OTP configuration error: ${error.message}`);
      return new ServiceUnavailableException(
        'OTP service is temporarily unavailable',
      );
    }

    if (error instanceof SlideError) {
      if (error.statusCode === 429) {
        return new HttpException(
          'Too many OTP requests',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      this.logger.error(
        `Slide OTP request failed with HTTP ${error.statusCode}: ${error.message}`,
      );
      return new ServiceUnavailableException(
        'OTP service is temporarily unavailable',
      );
    }

    this.logger.error(
      `Slide OTP request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return new ServiceUnavailableException(
      'OTP service is temporarily unavailable',
    );
  }
}
