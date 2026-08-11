import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

/**
 * What Razorpay Checkout hands the app when it closes.
 *
 * This body **is** ours — three known fields — so unlike the webhook it goes
 * through the global `ValidationPipe` normally.
 *
 * None of it is trusted. A valid signature over these three values proves only
 * that Razorpay produced the pair; the server still fetches the payment and
 * checks its status, order and amount before anything moves.
 */
export class VerifyPaymentDto {
  @ApiProperty({ example: 'order_NqRs1234567890' })
  @IsString()
  @IsNotEmpty()
  razorpayOrderId: string;

  @ApiProperty({ example: 'pay_NqRs1234567890' })
  @IsString()
  @IsNotEmpty()
  razorpayPaymentId: string;

  @ApiProperty({
    example: 'c4f0a3...',
    description:
      'HMAC-SHA256 of `order_id|payment_id`, keyed with the API secret.',
  })
  @IsString()
  // A hex digest or nothing. Cheap, and it keeps obviously malformed input out
  // of the constant-time comparison entirely.
  @Matches(/^[a-f0-9]{64}$/i, {
    message: 'signature must be a SHA-256 hex digest',
  })
  signature: string;
}
