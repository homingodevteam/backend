import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  SlideAuthError,
  SlideClient,
  SlideValidationError,
} from '@synquic/slide';
import { SlideOtpProvider } from './slide-otp-provider.service';

describe('SlideOtpProvider', () => {
  const otp = {
    send: jest.fn(),
    verify: jest.fn(),
    verifyToken: jest.fn(),
  };
  let provider: SlideOtpProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new SlideOtpProvider(
      { otp } as unknown as SlideClient,
      'widget-1',
    );
  });

  it('sends through the configured widget and returns the Slide request id', async () => {
    otp.send.mockResolvedValue({ requestId: 'request-1' });

    await expect(provider.sendOtp('+919876543210')).resolves.toEqual({
      providerRef: 'request-1',
    });
    expect(otp.send).toHaveBeenCalledWith({
      widgetId: 'widget-1',
      identifier: '+919876543210',
    });
  });

  it('verifies the OTP proof and binds it to the submitted phone', async () => {
    otp.verify.mockResolvedValue({ accessToken: 'proof-token' });
    otp.verifyToken.mockResolvedValue({
      verified: true,
      identifier: '919876543210',
      verifiedAt: new Date().toISOString(),
    });

    await expect(
      provider.verifyOtp('+919876543210', '123456', 'request-1'),
    ).resolves.toBe(true);
    expect(otp.verify).toHaveBeenCalledWith({
      requestId: 'request-1',
      otp: '123456',
    });
    expect(otp.verifyToken).toHaveBeenCalledWith({
      accessToken: 'proof-token',
    });
  });

  it('rejects a valid proof issued for a different phone', async () => {
    otp.verify.mockResolvedValue({ accessToken: 'proof-token' });
    otp.verifyToken.mockResolvedValue({
      verified: true,
      identifier: '+919999999999',
      verifiedAt: new Date().toISOString(),
    });

    await expect(
      provider.verifyOtp('+919876543210', '123456', 'request-1'),
    ).resolves.toBe(false);
  });

  it('treats an invalid or expired OTP as an ordinary failed verification', async () => {
    otp.verify.mockRejectedValue(new SlideValidationError('Invalid OTP'));

    await expect(
      provider.verifyOtp('+919876543210', '000000', 'request-1'),
    ).resolves.toBe(false);
  });

  it('maps rejected send input without exposing the provider body', async () => {
    otp.send.mockRejectedValue(new SlideValidationError('Bad identifier'));

    await expect(provider.sendOtp('+919876543210')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('maps credential failures to service unavailable', async () => {
    otp.send.mockRejectedValue(new SlideAuthError());

    await expect(provider.sendOtp('+919876543210')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
