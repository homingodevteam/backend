import { buildSlideOptions } from './slide.config';

describe('buildSlideOptions', () => {
  it('selects Slide when its credentials are present', () => {
    expect(
      buildSlideOptions({
        NODE_ENV: 'local',
        SLIDE_API_KEY: 'key',
        SLIDE_WIDGET_ID: 'widget',
        SLIDE_DEFAULT_CHANNEL: 'sms',
      }),
    ).toEqual({
      provider: 'slide',
      apiKey: 'key',
      widgetId: 'widget',
      defaultChannel: 'sms',
    });
  });

  it('uses the mock locally when no Slide credentials exist', () => {
    expect(buildSlideOptions({ NODE_ENV: 'local' }).provider).toBe('mock');
  });

  it('requires Slide credentials in production', () => {
    expect(() => buildSlideOptions({ NODE_ENV: 'production' })).toThrow(
      'Slide OTP is not configured',
    );
  });

  it('does not permit the mock provider in production', () => {
    expect(() =>
      buildSlideOptions({
        NODE_ENV: 'production',
        OTP_PROVIDER: 'mock',
      }),
    ).toThrow('OTP_PROVIDER=mock is not allowed in production');
  });
});
