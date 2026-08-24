import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { apiError } from '../../common/utils';
import { PrismaService } from '../../prisma/prisma.service';
import { S3Service } from '../../storage/s3.service';
import { RequestKycUploadUrlDto } from './dto/request-kyc-upload-url.dto';
import { MyDocumentDto } from './dto/my-document.dto';

/** A row for a document that was never uploaded. See `listMine`. */
function blankDocument(
  docType: 'aadhaar' | 'pan',
  title: string,
  updatedAt: Date,
): MyDocumentDto {
  return {
    docType,
    title,
    maskedDetail: null,
    status: 'pending',
    verifiedAt: null,
    rejectionReason: null,
    hasFile: false,
    updatedAt,
  };
}

/**
 * Thin wrapper over S3Service that fixes the KYC key prefix. The client PUTs
 * the file directly to S3 with the URL this returns; the platform never sees
 * the bytes.
 */
@Injectable()
export class KycDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  requestUploadUrl(
    proId: string,
    dto: RequestKycUploadUrlDto,
  ): Promise<{ key: string; uploadUrl: string; expiresIn: number }> {
    return this.s3.createUploadUrl(
      `kyc/${proId}/${dto.docType}`,
      dto.contentType,
    );
  }

  /**
   * The Pro's own documents, for the "My Documents" screen.
   *
   * -------------------------------------------------------------------------
   * READS THE LATEST APPLICATION, NOT THE APPROVED ONE
   * -------------------------------------------------------------------------
   * A rejected Pro submits a corrected application, and until that one is
   * decided it is the only record carrying the truth about what they uploaded.
   * Reading `approvedApplication` would show an approved Pro their old
   * documents after they had replaced one, and would show a re-applying Pro
   * nothing at all.
   *
   * Ordered by `createdAt` rather than `submittedAt`: a draft that has not
   * been submitted still has files attached, and hiding them means a Pro who
   * uploaded a PAN yesterday sees an empty screen today.
   *
   * Returns both rows unconditionally — a document with no file is a row that
   * says "not uploaded", which is exactly what a Pro needs to see. Filtering
   * them out leaves a short list with no explanation of what is missing.
   */
  async listMine(proId: string): Promise<MyDocumentDto[]> {
    const application = await this.prisma.proApplication.findFirst({
      where: { proId },
      orderBy: { createdAt: 'desc' },
    });

    // No application at all is a legitimate state — a Pro created by ops
    // directly has never filed one. Two "not uploaded" rows is the honest
    // answer, and it keeps the screen's shape identical either way.
    if (!application) {
      const now = new Date();
      return [
        blankDocument('aadhaar', 'Aadhaar Card', now),
        blankDocument('pan', 'PAN Card', now),
      ];
    }

    return [
      {
        docType: 'aadhaar',
        title: 'Aadhaar Card',
        maskedDetail: application.aadhaarNumberMasked,
        status: application.aadhaarStatus,
        verifiedAt: application.aadhaarVerifiedAt,
        rejectionReason: application.aadhaarRejectionReason,
        hasFile: Boolean(application.aadhaarUrl),
        updatedAt: application.updatedAt,
      },
      {
        docType: 'pan',
        title: 'PAN Card',
        maskedDetail: application.panNumberMasked,
        status: application.panStatus,
        verifiedAt: application.panVerifiedAt,
        rejectionReason: application.panRejectionReason,
        hasFile: Boolean(application.panUrl),
        updatedAt: application.updatedAt,
      },
    ];
  }

  /**
   * A view URL for one of **my own** documents.
   *
   * -------------------------------------------------------------------------
   * THE PRO ID IS THE AUTHORISATION, AND IT IS NOT OPTIONAL
   * -------------------------------------------------------------------------
   * `requestViewUrl` below takes an application id and trusts the caller to
   * have been permission-checked — true for the admin console, catastrophic
   * here. A Pro sends a `docType`, never an application id, and the record is
   * found *by their own id*. There is no parameter on this path that could
   * name somebody else's application, which is a stronger guarantee than
   * checking ownership after the fact.
   */
  async requestMyViewUrl(
    proId: string,
    docType: string,
  ): Promise<{ viewUrl: string; expiresIn: number }> {
    if (docType !== 'aadhaar' && docType !== 'pan') {
      throw apiError(
        'docType must be "aadhaar" or "pan"',
        HttpStatus.BAD_REQUEST,
      );
    }

    const application = await this.prisma.proApplication.findFirst({
      where: { proId },
      orderBy: { createdAt: 'desc' },
    });
    if (!application) {
      throw apiError('No documents on file', HttpStatus.NOT_FOUND);
    }

    const key =
      docType === 'aadhaar' ? application.aadhaarUrl : application.panUrl;
    if (!key) {
      throw apiError(`No ${docType} document on file`, HttpStatus.NOT_FOUND);
    }

    return this.s3.createViewUrl(key);
  }

  async requestViewUrl(
    applicationId: string,
    docType: string,
  ): Promise<{ viewUrl: string; expiresIn: number }> {
    if (docType !== 'aadhaar' && docType !== 'pan') {
      throw apiError(
        'docType must be "aadhaar" or "pan"',
        HttpStatus.BAD_REQUEST,
      );
    }

    const application = await this.prisma.proApplication.findUnique({
      where: { id: applicationId },
    });
    if (!application) throw new NotFoundException('Application not found');

    const key =
      docType === 'aadhaar' ? application.aadhaarUrl : application.panUrl;
    if (!key) {
      throw apiError(
        `No ${docType} document on this application`,
        HttpStatus.NOT_FOUND,
      );
    }

    return this.s3.createViewUrl(key);
  }
}
