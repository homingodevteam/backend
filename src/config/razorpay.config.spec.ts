import { buildRazorpayOptions } from './razorpay.config';

const complete = {
  NODE_ENV: 'local',
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'secret',
  RAZORPAY_WEBHOOK_SECRET: 'webhook_secret',
};

describe('buildRazorpayOptions', () => {
  it('builds a configuration when all three credentials are present', () => {
    expect(buildRazorpayOptions(complete)).toEqual({
      keyId: 'rzp_test_key',
      keySecret: 'secret',
      webhookSecret: 'webhook_secret',
      baseUrl: 'https://api.razorpay.com/v1',
    });
  });

  /**
   * The difference from `buildRedisOptions` and `buildS3Options`, which throw.
   * Cash is the default payment mode and needs no gateway, so a developer with
   * no Razorpay keys must still be able to run the whole product.
   */
  it('returns undefined rather than throwing when nothing is set', () => {
    expect(buildRazorpayOptions({ NODE_ENV: 'local' })).toBeUndefined();
  });

  it('treats blank values as absent, since a blank .env line shadows the fallback', () => {
    expect(
      buildRazorpayOptions({
        NODE_ENV: 'local',
        RAZORPAY_KEY_ID: '  ',
        RAZORPAY_KEY_SECRET: '',
        RAZORPAY_WEBHOOK_SECRET: '   ',
      }),
    ).toBeUndefined();
  });

  /**
   * Half-configured is worse than unconfigured: order creation would work and
   * webhook verification would reject every delivery, leaving paid bookings
   * stuck in `awaiting_payment` with the customer's money taken.
   */
  it.each([
    ['RAZORPAY_KEY_ID'],
    ['RAZORPAY_KEY_SECRET'],
    ['RAZORPAY_WEBHOOK_SECRET'],
  ])('refuses to start with %s missing while the others are set', (missing) => {
    const partial = { ...complete, [missing]: undefined };
    expect(() => buildRazorpayOptions(partial)).toThrow(/half-configured/);
  });

  it('allows the base url to be pointed at a mock gateway', () => {
    expect(
      buildRazorpayOptions({
        ...complete,
        RAZORPAY_BASE_URL: 'http://localhost:9999/v1',
      }),
    ).toMatchObject({ baseUrl: 'http://localhost:9999/v1' });
  });
});
