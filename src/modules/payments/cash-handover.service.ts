import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { CashHandover } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { fromPaise, toPaise } from './payments.money';
import { LEDGER_PORT, type LedgerPort } from './ports/ledger.port';

@Injectable()
export class CashHandoverService {
  private readonly logger = new Logger(CashHandoverService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
  ) {}

  /**
   * Feature 15 — recovery by handover, never by netting.
   *
   * The Pro declares what they are handing over. Declaring alone moves
   * nothing: until an admin has counted it, the platform's claim on that money
   * is unchanged. Two people have to agree before a balance clears, which is
   * the only control on this whole flow.
   */
  async declare(proId: string, declaredAmount: string): Promise<CashHandover> {
    const pro = await this.prisma.pro.findUnique({
      where: { id: proId },
      select: { cashInHand: true },
    });
    if (!pro) throw apiError('Pro not found', HttpStatus.NOT_FOUND);

    const declaredPaise = toPaise(declaredAmount);
    if (declaredPaise <= 0) {
      throw apiError(
        'Declare the amount you are handing over',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'declaredAmount',
            message: 'Must be more than zero',
            code: 'HANDOVER_AMOUNT_INVALID',
          },
        ],
      );
    }

    if (declaredPaise > toPaise(pro.cashInHand.toString())) {
      throw apiError(
        `You are recorded as carrying ${pro.cashInHand.toString()}, so you cannot hand over more than that`,
        HttpStatus.CONFLICT,
        [
          {
            field: 'declaredAmount',
            message: 'Exceeds the recorded balance',
            code: 'HANDOVER_EXCEEDS_BALANCE',
          },
        ],
      );
    }

    const open = await this.prisma.cashHandover.findFirst({
      where: { proId, status: 'declared' },
    });

    if (open) {
      // One open declaration per Pro, also enforced by a partial unique index.
      // Two in flight would let the same banknotes be confirmed twice and
      // drive the balance below what is really owed.
      throw apiError(
        'You already have a handover waiting to be confirmed',
        HttpStatus.CONFLICT,
        [
          {
            field: 'declaredAmount',
            message: `Handover ${open.id} is still open`,
            code: 'HANDOVER_ALREADY_OPEN',
          },
        ],
      );
    }

    return this.prisma.cashHandover.create({
      data: { proId, declaredAmount },
    });
  }

  /**
   * The admin counted it. This is the only operation in the system that
   * reduces `Pro.cashInHand`.
   *
   * `confirmedAmount` is what was actually counted and is deliberately allowed
   * to differ from what was declared — the variance is the entire point of
   * counting, and silently accepting the declared figure would make the count
   * ceremonial. The balance moves by what was **counted**, not what was
   * claimed, so a short handover leaves the difference still owed.
   */
  async confirm(input: {
    handoverId: string;
    adminId: string;
    confirmedAmount: string;
    notes?: string;
  }): Promise<CashHandover> {
    const handover = await this.openOrFail(input.handoverId);

    const confirmedPaise = toPaise(input.confirmedAmount);
    if (confirmedPaise < 0) {
      throw apiError(
        'A confirmed amount cannot be negative',
        HttpStatus.BAD_REQUEST,
      );
    }

    const confirmed = await this.prisma.$transaction(async (tx) => {
      const pro = await tx.pro.findUnique({
        where: { id: handover.proId },
        select: { cashInHand: true },
      });

      const balancePaise = pro ? toPaise(pro.cashInHand.toString()) : 0;
      if (confirmedPaise > balancePaise) {
        // The Pro handed over more than we thought they held. Real, and worth
        // refusing rather than driving the balance negative: it means a
        // collection was never recorded, which module 9's reconciliation must
        // find before the books are corrected.
        throw apiError(
          `Counted ${input.confirmedAmount} against a recorded balance of ${fromPaise(balancePaise)}. ` +
            'Reconcile the collections behind it before confirming.',
          HttpStatus.CONFLICT,
          [
            {
              field: 'confirmedAmount',
              message: 'Exceeds the recorded balance',
              code: 'HANDOVER_EXCEEDS_BALANCE',
            },
          ],
        );
      }

      const updated = await tx.cashHandover.update({
        where: { id: handover.id },
        data: {
          status: 'confirmed',
          confirmedAmount: input.confirmedAmount,
          confirmedAt: new Date(),
          confirmedByAdminId: input.adminId,
          ...(input.notes ? { notes: input.notes } : {}),
        },
      });

      await tx.pro.update({
        where: { id: handover.proId },
        data: { cashInHand: { decrement: input.confirmedAmount } },
      });

      return updated;
    });

    if (confirmedPaise !== toPaise(handover.declaredAmount.toString())) {
      this.logger.warn(
        `Handover ${handover.id}: Pro ${handover.proId} declared ` +
          `${handover.declaredAmount.toString()} but ${input.confirmedAmount} was counted.`,
      );
    }

    await this.ledger.recordHandover({
      handoverId: confirmed.id,
      proId: confirmed.proId,
      amount: input.confirmedAmount,
    });

    return confirmed;
  }

  /**
   * The Pro turned up without the money, or the count could not be completed.
   * The balance is untouched — nothing was recovered, so nothing clears.
   */
  async reject(input: {
    handoverId: string;
    adminId: string;
    reason: string;
  }): Promise<CashHandover> {
    const handover = await this.openOrFail(input.handoverId);

    return this.prisma.cashHandover.update({
      where: { id: handover.id },
      data: {
        status: 'rejected',
        rejectionReason: input.reason,
        confirmedByAdminId: input.adminId,
      },
    });
  }

  listForPro(proId: string): Promise<CashHandover[]> {
    return this.prisma.cashHandover.findMany({
      where: { proId },
      orderBy: { declaredAt: 'desc' },
    });
  }

  listPending(): Promise<CashHandover[]> {
    return this.prisma.cashHandover.findMany({
      where: { status: 'declared' },
      orderBy: { declaredAt: 'asc' },
    });
  }

  private async openOrFail(handoverId: string): Promise<CashHandover> {
    const handover = await this.prisma.cashHandover.findUnique({
      where: { id: handoverId },
    });

    if (!handover) throw apiError('Handover not found', HttpStatus.NOT_FOUND);

    if (handover.status !== 'declared') {
      throw apiError(
        `This handover was already ${handover.status}`,
        HttpStatus.CONFLICT,
        [
          {
            field: 'status',
            message: 'Only an open declaration can be confirmed or rejected',
            code: 'HANDOVER_NOT_OPEN',
          },
        ],
      );
    }

    return handover;
  }
}
