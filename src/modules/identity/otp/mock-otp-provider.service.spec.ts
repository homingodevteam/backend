import { MockOtpProvider } from './mock-otp-provider.service';

function build(values: Record<string, string> = {}) {
  const redis = {
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    raw: { ttl: jest.fn() },
  };
  const config = {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback),
  };
  return {
    redis,
    provider: new MockOtpProvider(redis as never, config as never),
  };
}

describe('MockOtpProvider deterministic fixture', () => {
  it('uses MOCK_OTP_CODE when an isolated test configures it', async () => {
    const { provider, redis } = build({ MOCK_OTP_CODE: '123456' });

    await provider.sendOtp('+917828241099');

    const stored = JSON.parse(redis.set.mock.calls[0][1] as string) as {
      code: string;
    };
    expect(stored.code).toBe('123456');
  });

  it('rejects an invalid configured fixture code', async () => {
    const { provider } = build({ MOCK_OTP_CODE: '123' });

    await expect(provider.sendOtp('+917828241099')).rejects.toThrow(
      'MOCK_OTP_CODE must contain exactly 6 digits',
    );
  });
});
