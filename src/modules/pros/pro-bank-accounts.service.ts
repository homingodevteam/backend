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
}
