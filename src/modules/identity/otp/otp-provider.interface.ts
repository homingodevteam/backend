export const OTP_PROVIDER = Symbol('OTP_PROVIDER');

export interface OtpSendResult {
  /** Opaque reference from the provider, stored for audit — never a code. */
  providerRef: string;
}

/**
 * Seam for OTP delivery and verification.
 * Production uses Synquic Slide; local/test environments may use
 * MockOtpProvider.
 */
export interface OtpProvider {
  sendOtp(phone: string): Promise<OtpSendResult>;
  verifyOtp(phone: string, code: string, providerRef: string): Promise<boolean>;
}
