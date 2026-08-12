import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
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
import { successResponse } from '../../common/utils';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import {
  CreateIncentiveDto,
  IncentiveDto,
  IncentiveProgressQueryDto,
  IncentiveQueryDto,
  UpdateIncentiveDto,
} from './dto/incentive.dto';
import { IncentivesService } from './incentives.service';

@ApiTags('Admin — Incentives')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/incentives')
export class AdminIncentivesController {
  constructor(private readonly incentives: IncentivesService) {}

  @Get()
  @RequirePermissions(PermissionCode.INCENTIVE_MANAGE)
  @ApiOperation({
    summary: 'List bonus schemes',
    description:
      'Check `hasEvaluator` on every row. When it is false the scheme tracks ' +
      'nothing and will never pay, whatever its dates and reward say.',
  })
  @ApiOkEnvelope(IncentiveDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  list(@Query() query: IncentiveQueryDto) {
    return this.incentives.list(query);
  }

  @Post()
  @RequirePermissions(PermissionCode.INCENTIVE_MANAGE)
  @ApiOperation({
    summary: 'Create a bonus scheme',
    description:
      '`criteriaJson` is validated against `incentiveType` here, so a scheme ' +
      'cannot be stored in a shape its own evaluator cannot read.\n\n' +
      'Creating a `streak` or `surge_slot` scheme **succeeds** and returns ' +
      '`hasEvaluator: false` with a message saying so. Nobody has defined what ' +
      'breaks a streak or what makes a slot surge, and guessing would produce a ' +
      'payout dispute — but the column accepts the type, so the scheme can be ' +
      'configured ready for when the rules exist.',
  })
  @ApiCreatedEnvelope(IncentiveDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.BAD_REQUEST,
    HttpStatus.NOT_FOUND,
  )
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateIncentiveDto,
  ) {
    const created = await this.incentives.create(dto, user.id);
    return successResponse({
      data: created,
      statusCode: HttpStatus.CREATED,
      message: created.hasEvaluator
        ? 'Incentive created.'
        : `Incentive created, but "${created.incentiveType}" has no evaluator yet — it will track nothing and pay nobody.`,
    });
  }

  @Get(':id')
  @RequirePermissions(PermissionCode.INCENTIVE_MANAGE)
  @ApiOperation({ summary: 'One bonus scheme' })
  @ApiOkEnvelope(IncentiveDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  one(@Param('id') id: string) {
    return this.incentives.getOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PermissionCode.INCENTIVE_MANAGE)
  @ApiOperation({
    summary: 'Edit a bonus scheme',
    description:
      'Applies to runs still in progress. A bonus already credited keeps the ' +
      'reward snapshotted onto it — raising the reward does not top up March, ' +
      'and lowering it does not take money back.',
  })
  @ApiOkEnvelope(IncentiveDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.BAD_REQUEST,
    HttpStatus.NOT_FOUND,
  )
  update(@Param('id') id: string, @Body() dto: UpdateIncentiveDto) {
    return this.incentives.update(id, dto);
  }

  @Post(':id/deactivate')
  @RequirePermissions(PermissionCode.INCENTIVE_MANAGE)
  @ApiOperation({
    summary: 'Stop a scheme crediting anything further',
    description:
      'Deactivation, never deletion. A bonus already earned points at this row, ' +
      'and removing it would leave a Pro’s statement saying they were paid for ' +
      'a reason nobody can name.',
  })
  @ApiOkEnvelope(IncentiveDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async deactivate(@Param('id') id: string) {
    const updated = await this.incentives.deactivate(id);
    return successResponse({
      data: updated,
      message: 'Deactivated. Bonuses already earned are unaffected.',
    });
  }

  @Get(':id/progress')
  @RequirePermissions(PermissionCode.INCENTIVE_MANAGE)
  @ApiOperation({
    summary: 'Who has won this, and who is close',
    description:
      'One row per Pro per period. `contributingJobs` is how many jobs are ' +
      'actually standing behind the figure — a reversal removes one.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  progress(@Param('id') id: string, @Query() query: IncentiveProgressQueryDto) {
    return this.incentives.progress(id, query);
  }
}
