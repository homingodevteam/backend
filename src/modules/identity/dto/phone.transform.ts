/**
 * Canonical auth identity format. Indian mobile numbers may be entered as
 * ten national digits; everything persisted or sent to an OTP provider is
 * normalized to E.164 first.
 */
export function normalizePhone(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const phone = value.trim();
  return /^[6-9]\d{9}$/.test(phone) ? `+91${phone}` : phone;
}
