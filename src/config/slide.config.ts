type Env = Record<string, string | undefined>;

export type OtpProviderName = 'mock' | 'slide';

export interface SlideOptions {
  provider: OtpProviderName;
  apiKey?: string;
  widgetId?: string;
  defaultChannel?: string;
}

function str(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Selects Slide automatically when its credentials are present. Local/test
 * environments without credentials keep using the mock provider; production
 * never silently falls back to a mock that logs OTP codes.
 */
export function buildSlideOptions(env: Env = process.env): SlideOptions {
  const nodeEnv = str(env.NODE_ENV) ?? 'local';
  const apiKey = str(env.SLIDE_API_KEY);
  const widgetId = str(env.SLIDE_WIDGET_ID);
  const defaultChannel = str(env.SLIDE_DEFAULT_CHANNEL);
  const configuredProvider = str(env.OTP_PROVIDER)?.toLowerCase();

  if (
    configuredProvider !== undefined &&
    configuredProvider !== 'mock' &&
    configuredProvider !== 'slide'
  ) {
    throw new Error('OTP_PROVIDER must be either "mock" or "slide".');
  }

  const provider: OtpProviderName = configuredProvider
    ? configuredProvider
    : apiKey && widgetId
      ? 'slide'
      : nodeEnv === 'production'
        ? 'slide'
        : 'mock';

  if (provider === 'slide' && (!apiKey || !widgetId)) {
    throw new Error(
      `Slide OTP is not configured. Set SLIDE_API_KEY and SLIDE_WIDGET_ID in .env.${nodeEnv}.`,
    );
  }

  if (nodeEnv === 'production' && provider !== 'slide') {
    throw new Error('OTP_PROVIDER=mock is not allowed in production.');
  }

  return { provider, apiKey, widgetId, defaultChannel };
}
