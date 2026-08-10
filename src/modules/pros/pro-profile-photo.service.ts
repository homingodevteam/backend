import { HttpStatus, Injectable } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { Pro } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { S3Service } from '../../storage/s3.service';
import { RequestProfilePhotoUploadUrlDto } from './dto/request-profile-photo-upload-url.dto';

@Injectable()
export class ProProfilePhotoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  requestUploadUrl(
    proId: string,
    dto: RequestProfilePhotoUploadUrlDto,
  ): Promise<{ key: string; uploadUrl: string; expiresIn: number }> {
    return this.s3.createUploadUrl(`profile-photos/${proId}`, dto.contentType);
  }

  async setPhoto(proId: string, key: string): Promise<Pro> {
    const prefix = `profile-photos/${proId}/`;
    const objectId = key.slice(prefix.length);
    if (
      !key.startsWith(prefix) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        objectId,
      )
    ) {
      throw apiError(
        'profile photo key was not issued for this Pro',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Store the private object key. Customer-facing projections must issue a
    // short-lived signed GET URL; a temporary signed URL is never persisted.
    return this.prisma.pro.update({
      where: { id: proId },
      data: { profilePhotoUrl: key },
    });
  }
}
