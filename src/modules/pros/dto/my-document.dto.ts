import { ApiProperty } from '@nestjs/swagger';

/**
 * One row of "My Documents", as the Pro's own app shows it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT JUST `ProApplicationDto`
 * ---------------------------------------------------------------------------
 * The application record carries the raw S3 keys, the verifying admin's id and
 * the internal actor type. None of that belongs on a handset: the key is a
 * capability (anybody holding it can ask for a view URL), and which admin
 * pressed approve is ops' business, not the Pro's.
 *
 * So this is a deliberate narrowing — identity, state, and the two dates a Pro
 * can act on. `docType` is the only handle that goes back over the wire, and
 * the server re-resolves it to a key on every view request.
 */
export class MyDocumentDto {
  @ApiProperty({
    description:
      'Stable handle for this row. Echo it back to fetch a view URL.',
    enum: ['aadhaar', 'pan'],
  })
  docType: 'aadhaar' | 'pan';

  @ApiProperty({ description: 'What the Pro sees as the row title' })
  title: string;

  @ApiProperty({
    description:
      'Masked identifier — enough for the Pro to recognise their own document, ' +
      'useless to anybody reading over their shoulder. Null when never captured.',
    nullable: true,
  })
  maskedDetail: string | null;

  @ApiProperty({
    description:
      'pending | verified | rejected. Mirrors the column an admin writes; ' +
      'the app maps it to its own three chips.',
    enum: ['pending', 'verified', 'rejected'],
  })
  status: string;

  @ApiProperty({
    description: 'When it was verified, if it has been.',
    nullable: true,
  })
  verifiedAt: Date | null;

  @ApiProperty({
    description:
      'Why it was turned down. The Pro must be told which document failed and ' +
      'why, or "Update Required" is a nag with no next step (US-6.3).',
    nullable: true,
  })
  rejectionReason: string | null;

  @ApiProperty({
    description:
      'False when nothing was ever uploaded. The app must not offer to open a ' +
      'document that does not exist.',
  })
  hasFile: boolean;

  @ApiProperty({ description: 'Last change to this document.' })
  updatedAt: Date;
}
