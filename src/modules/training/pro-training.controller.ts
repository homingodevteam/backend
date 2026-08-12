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
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { AllowSuspendedProRead } from '../identity/decorators/allow-suspended-pro-read.decorator';
import { RequireActorType } from '../identity/decorators/require-actor-type.decorator';
import { ActorTypeGuard } from '../identity/guards/actor-type.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { CurriculumService } from './curriculum.service';
import {
  CurriculumDto,
  CurriculumItemDto,
  CurriculumQueryDto,
  ProSessionDto,
  QuizResultDto,
  SubmitQuizDto,
  TrainingManifestDto,
  TrainingModuleDetailDto,
  UpdateProgressDto,
} from './dto/training.dto';

/**
 * Training, in the Pro app.
 *
 * ## The reads are `@AllowSuspendedProRead`
 *
 * A Pro suspended over a quality concern is very often a Pro who needs to
 * retake a module before they can be reinstated. Locking them out of the
 * training is the one thing guaranteed to keep them suspended. The writes —
 * progress and quiz submission — are not, because they change a record that
 * feeds an eligibility decision.
 *
 * ## Route prefix
 *
 * `pros/me/training/*`. Three controllers already serve `pros/me` (module 6's
 * profile, module 8's earnings, module 7's payments); a fourth is fine because
 * the segments are distinct. `test/http-routes.e2e-spec.ts` boots the real
 * HTTP layer and fails on a duplicate — CONFLICTS_AND_DECISIONS #56 is what
 * happens when only the DI graph is tested.
 */
@ApiTags('Pro — Training')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ActorTypeGuard)
@RequireActorType('pro')
@Controller('pros/me/training')
export class ProTrainingController {
  constructor(private readonly curriculum: CurriculumService) {}

  @Get()
  @AllowSuspendedProRead()
  @ApiOperation({
    summary: 'What I need to learn',
    description:
      'Derived live from the services you are active on — assign a service ' +
      'and the curriculum changes the same instant. A module attached to a ' +
      'parent trade appears for every service beneath it.\n\n' +
      'Mandatory modules sort first. `mandatoryOutstanding` is what stands ' +
      'between you and being activated for a trade, where the gate is on.\n\n' +
      'Pass `?serviceId=` for the in-job case: what should I be able to read ' +
      'standing in front of this particular job.',
  })
  @ApiOkEnvelope(CurriculumDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CurriculumQueryDto,
  ): Promise<CurriculumDto> {
    return this.curriculum.curriculum(user.id, query.serviceId);
  }

  @Get('manifest')
  @AllowSuspendedProRead()
  @ApiOperation({
    summary: 'Everything worth downloading on wifi',
    description:
      'Sizes, versions and six-hour URLs so the app can pre-download and work ' +
      'in a basement.\n\n' +
      '**`version` is the field that matters.** Compare it against what you ' +
      'cached: a change means the content was replaced and the copy on the ' +
      'phone is last month’s procedure. Nothing else in this response can ' +
      'tell you that.\n\n' +
      '`wifiRecommended` is advice for anything over 10 MB, not a rule the ' +
      'server enforces — a Pro on unlimited data should be able to override ' +
      'it.',
  })
  @ApiOkEnvelope(TrainingManifestDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  manifest(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TrainingManifestDto> {
    return this.curriculum.manifest(user.id);
  }

  @Get('sessions')
  @AllowSuspendedProRead()
  @ApiOperation({
    summary: 'My classroom and field sessions',
    description:
      'Read-only. Enrolment is done by an admin — capacity is a room with ' +
      'chairs in it, and whoever booked the room knows how many there are.',
  })
  @ApiOkEnvelope(ProSessionDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  sessions(@CurrentUser() user: AuthenticatedUser): Promise<ProSessionDto[]> {
    return this.curriculum.sessions(user.id);
  }

  @Get(':moduleId')
  @AllowSuspendedProRead()
  @ApiOperation({
    summary: 'Open a module',
    description:
      '`contentUrl` is a presigned GET valid for six hours — long, because a ' +
      '48 MB video on mobile data does not download in five minutes.\n\n' +
      '`lastPositionSeconds` is where you left off; resume there rather than ' +
      'restarting.\n\n' +
      'For a quiz, `quizQuestionIds` lists the questions in key order. **The ' +
      'answers are not in this response and never will be** — grading happens ' +
      'on the server, because a score computed on the phone is not one anyone ' +
      'can stand behind.',
  })
  @ApiOkEnvelope(TrainingModuleDetailDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('moduleId') moduleId: string,
  ): Promise<TrainingModuleDetailDto> {
    return this.curriculum.moduleDetail(user.id, moduleId);
  }

  @Patch(':moduleId/progress')
  @ApiOperation({
    summary: 'Save where I am',
    description:
      'Send this periodically, not only on exit — an app killed mid-video is ' +
      'the case the resume position exists for.\n\n' +
      '`percentComplete` only moves forward: scrubbing back through a video ' +
      'is normal and must not undo a completion. Reaching 100 completes the ' +
      'module — **except for a quiz**, which is completed by passing it.',
  })
  @ApiOkEnvelope(CurriculumItemDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  progress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('moduleId') moduleId: string,
    @Body() dto: UpdateProgressDto,
  ): Promise<CurriculumItemDto> {
    return this.curriculum.updateProgress(user.id, moduleId, dto);
  }

  @Post(':moduleId/quiz')
  @ApiOperation({
    summary: 'Submit a quiz attempt',
    description:
      'Graded on the server against an answer key the app never sees.\n\n' +
      'A question the quiz defines and you omit counts as wrong — a client ' +
      'cannot shrink the denominator by leaving out what it does not know.\n\n' +
      '`attemptsLeft` reaching 0 sets `isLocked`, and further attempts are a ' +
      '409 until an admin resets it. `bestQuizScore` is what the activation ' +
      'gate reads, so a curious retake cannot un-qualify you.',
  })
  @ApiOkEnvelope(QuizResultDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  quiz(
    @CurrentUser() user: AuthenticatedUser,
    @Param('moduleId') moduleId: string,
    @Body() dto: SubmitQuizDto,
  ): Promise<QuizResultDto> {
    return this.curriculum.submitQuiz(user.id, moduleId, dto);
  }
}
