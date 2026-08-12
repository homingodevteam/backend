import {
  LedgerBalancesService,
  isDebitNormal,
} from './ledger-balances.service';

const decimal = (value: string) => ({ toString: () => value });

function buildDeps() {
  const prisma = {
    ledgerEntry: {
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
    },
  };
  return { prisma };
}

function build(deps: ReturnType<typeof buildDeps>): LedgerBalancesService {
  return new LedgerBalancesService(deps.prisma as never);
}

/**
 * Getting this backwards does not throw — it silently reports every balance
 * negated, which reads as a catastrophe or as a windfall depending on the
 * account. Hence a test per account family.
 */
describe('isDebitNormal', () => {
  it.each([
    'gateway:razorpay',
    'bank:platform',
    'cash_in_hand:pro-1',
    'expense:incentives',
  ])(
    'treats %s as an asset or expense — it grows on the debit side',
    (account) => {
      expect(isDebitNormal(account)).toBe(true);
    },
  );

  it.each(['revenue:bookings', 'revenue:recoveries', 'payable:pro:pro-1'])(
    'treats %s as revenue or a liability — it grows on the credit side',
    (account) => {
      expect(isDebitNormal(account)).toBe(false);
    },
  );
});

describe('balances', () => {
  it('signs each account by its own normal side', async () => {
    const deps = buildDeps();
    deps.prisma.ledgerEntry.groupBy
      // debits
      .mockResolvedValueOnce([
        {
          debitAccount: 'cash_in_hand:pro-1',
          _sum: { amount: decimal('4000.00') },
        },
        {
          debitAccount: 'payable:pro:pro-1',
          _sum: { amount: decimal('800.00') },
        },
      ])
      // credits
      .mockResolvedValueOnce([
        {
          creditAccount: 'cash_in_hand:pro-1',
          _sum: { amount: decimal('1000.00') },
        },
        {
          creditAccount: 'payable:pro:pro-1',
          _sum: { amount: decimal('1000.00') },
        },
      ]);

    const rows = await build(deps).balances();

    // Asset: debits less credits — the Pro is still holding ₹3,000.
    expect(rows.find((r) => r.account === 'cash_in_hand:pro-1')?.balance).toBe(
      '3000.00',
    );
    // Liability: credits less debits — ₹200 still owed.
    expect(rows.find((r) => r.account === 'payable:pro:pro-1')?.balance).toBe(
      '200.00',
    );
  });

  it('includes an account that only ever appears on one leg', async () => {
    const deps = buildDeps();
    deps.prisma.ledgerEntry.groupBy
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          creditAccount: 'revenue:bookings',
          _sum: { amount: decimal('5000.00') },
        },
      ]);

    const rows = await build(deps).balances();
    expect(rows).toEqual([
      {
        account: 'revenue:bookings',
        debits: '0.00',
        credits: '5000.00',
        balance: '5000.00',
      },
    ]);
  });

  it('passes a prefix filter through to both legs', async () => {
    const deps = buildDeps();

    await build(deps).balances('payable:pro:');

    expect(deps.prisma.ledgerEntry.groupBy.mock.calls[0][0].where).toEqual({
      debitAccount: { startsWith: 'payable:pro:' },
    });
    expect(deps.prisma.ledgerEntry.groupBy.mock.calls[1][0].where).toEqual({
      creditAccount: { startsWith: 'payable:pro:' },
    });
  });

  it('is zero for an empty ledger rather than throwing', async () => {
    const deps = buildDeps();
    await expect(build(deps).balances()).resolves.toEqual([]);
  });
});

describe('balanceOf', () => {
  it('nets a settled Pro to zero', async () => {
    const deps = buildDeps();
    deps.prisma.ledgerEntry.aggregate
      .mockResolvedValueOnce({ _sum: { amount: decimal('1000.00') } }) // debits
      .mockResolvedValueOnce({ _sum: { amount: decimal('1000.00') } }); // credits

    await expect(build(deps).balanceOf('payable:pro:pro-1')).resolves.toBe(
      '0.00',
    );
  });

  it('is zero for an account nothing has touched', async () => {
    const deps = buildDeps();
    await expect(build(deps).balanceOf('bank:platform')).resolves.toBe('0.00');
  });
});
