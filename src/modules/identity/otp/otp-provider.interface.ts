export const OTP_PROVIDER = Symbol('OTP_PROVIDER');

export interface OtpSendResult {
  /** Opaque reference from the provider, stored for audit — never a code. */
  providerRef: string;
}

/**
 * Seam for the real third-party OTP provider (Synquic Slide / MSG91).
 * Neither is wired up yet — no API keys in .env.example — so only
 * MockOtpProvider implements this today. Swapping in the real one later is
 * a new class + a provider binding change in identity.module.ts.
 */
export interface OtpProvider {
  sendOtp(phone: string): Promise<OtpSendResult>;
  verifyOtp(phone: string, code: string, providerRef: string): Promise<boolean>;
}
