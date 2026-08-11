import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiCreatedEnvelope,
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { PrismaService } from '../../prisma/prisma.service';
import { RequireActorType } from '../identity/decorators/require-actor-type.decorator';
import { ActorTypeGuard } from '../identity/guards/actor-type.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { apiError } from '../../common/utils';
import {
  BookingPaymentDto,
  CheckoutHandoffDto,
  OrderDto,
} from './dto/order.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { OrdersService } from './orders.service';

/**
 * The customer's whole surface on payment: open checkout, close the loop, look
 * at what happened.
 */
@ApiTags('Payments')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ActorTypeGuard)
@RequireActorType('customer')
@Controller('bookings/:id/payment')
export class PaymentsController {
  constructor(
    private readonly orders: OrdersService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Create the Razorpay order this booking will be paid through, and return
   * everything Checkout needs.
   */
  @Post('order')
  @ApiOperation({
    summary: 'Open checkout for a booking',
    description:
      'The amount comes from the booking, never from the request — that is ' +
      'the whole reason the order is created server-side. Safe to call again: ' +
      'an order still inside its validity window is returned rather than ' +
      'duplicated, and an expired one is reissued.',
  })
  @ApiCreatedEnvelope(CheckoutHandoffDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  createOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') bookingId: string,
  ): Promise<CheckoutHandoffDto> {
    return this.orders.createForBooking(bookingId, user.id);
  }

  /**
   * Report the outcome Checkout handed back.
   *
   * The signature is checked, and then the payment is fetched from Razorpay
   * and its status, order and amount are verified against ours. A client
   * saying "it worked" is never enough on its own.
   */
  @Post('verify')
  @ApiOperation({
    summary: 'Verify a completed checkout',
    description:
      'A valid signature alone does not mark a booking paid. The server ' +
      'independently confirms the payment with Razorpay first. If this call ' +
      'is missed entirely, the webhook still completes the booking.',
  })
  @ApiOkEnvelope(OrderDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  verify(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') bookingId: string,
    @Body() dto: VerifyPaymentDto,
  ): Promise<OrderDto> {
    return this.orders.verifyCheckout({
      bookingId,
      customerId: user.id,
      ...dto,
    }) as unknown as Promise<OrderDto>;
  }

  /** What has been paid, and how — for either mode. */
  @Get()
  @ApiOperation({
    summary: 'Payment status of a booking',
    description:
      'A cash booking returns an empty `orders` array, because it has no ' +
      'Order row at all — not because none was found.',
  })
  @ApiOkEnvelope(BookingPaymentDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async find(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') bookingId: string,
  ): Promise<BookingPaymentDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (!booking || booking.customerId !== user.id) {
      throw apiError('Booking not found', HttpStatus.NOT_FOUND);
    }

    const orders = await this.orders.findForBooking(bookingId, user.id);

    return {
      paymentMode: booking.paymentMode,
      paymentStatus: booking.paymentStatus,
      flatPrice: booking.flatPrice.toString(),
      cashCollectedAmount: booking.cashCollectedAmount?.toString() ?? null,
      cashCollectedAt: booking.cashCollectedAt,
      orders: orders as unknown as OrderDto[],
    };
  }
}
