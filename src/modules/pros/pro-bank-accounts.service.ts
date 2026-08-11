import { Injectable, NotFoundException } from '@nestjs/common';
import type { ProBankAccount } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBankAccountDto } from './dto/create-bank-account.dto';
import { UpdateBankAccountDto } from './dto/update-bank-account.dto';

@Injectable()
export class ProBankAccountsService {
  constructor(private readonly prisma: PrismaService) {}

  list(proId: string): Promise<ProBankAccount[]> {
    return this.prisma.proBankAccount.findMany({ where: { proId } });
  }

  async create(
    proId: string,
    dto: CreateBankAccountDto,
  ): Promise<ProBankAccount> {
    if (dto.isPrimary) {
      await this.prisma.proBankAccount.updateMany({
        where: { proId },
        data: { isPrimary: false },
      });
    }

    return this.prisma.proBankAccount.create({
      data: { ...dto, proId },
    });
  }

  async update(
    proId: string,
    id: string,
    dto: UpdateBankAccountDto,
  ): Promise<ProBankAccount> {
    const account = await this.prisma.proBankAccount.findFirst({
      where: { id, proId },
    });
    if (!account) throw new NotFoundException('Bank account not found');

    if (dto.isPrimary) {
      await this.prisma.proBankAccount.updateMany({
        where: { proId },
        data: { isPrimary: false },
      });
    }

    return this.prisma.proBankAccount.update({
      where: { id },
      data: dto,
    });
  }

  /**
   * Admin-only. `isVerified` is deliberately absent from UpdateBankAccountDto
   * so a Pro can never vouch for their own payout destination — this is the
   * only path that sets it.
   *
   * Note this is a bookkeeping flag, not a check: the full account number is
   * never stored (only the masked tail), so whatever proof an admin relied on
   * happened outside this system.
   */
  async setVerified(
    proId: string,
    id: string,
    isVerified: boolean,
  ): Promise<ProBankAccount> {
    const account = await this.prisma.proBankAccount.findFirst({
      where: { id, proId },
    });
    if (!account) throw new NotFoundException('Bank account not found');

    return this.prisma.proBankAccount.update({
      where: { id },
      data: { isVerified },
    });
  }
}
