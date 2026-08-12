import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { apiError } from '../../common/utils';
import type { SessionStatus } from './training.types';
import type {
  CreateSessionDto,
  EnrolProsDto,
  MarkAttendanceDto,
  SessionQueryDto,
  TrainingSessionDto,
  UpdateSessionDto,
} from './dto/training.dto';

/**
 * Classroom and field training the client runs in person.
 *
 * Entirely admin-driven: an admin schedules, an admin enrols, an admin marks
 * who turned up. A Pro reads their own sessions and cannot self-enrol —
 * capacity is a room with chairs in it, and the person who booked the room is
 * the one who knows how many there are.
 *
 * Attendance changes no eligibility and unlocks no module. It is a record of
 * what happened, which is the honest scope: nobody has said what a classroom
 * session should count for, and inventing an answer would be worse than
 * leaving the record plain.
 */
@Injectable()
export class TrainingSessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: SessionQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.OfflineTrainingSessionWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.offlineTrainingSession.findMany({
        where,
        include: { _count: { select: { attendance: true } } },
        orderBy: { scheduledAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.offlineTrainingSession.count({ where }),
    ]);

    return {
      data: rows.map((row) => this.toDto(row, row._count.attendance)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async get(id: string): Promise<TrainingSessionDto> {
    const session = await this.prisma.offlineTrainingSession.findUnique({
      where: { id },
      include: {
        attendance: {
          include: { pro: { select: { fullName: true } } },
          orderBy: { enrolledAt: 'asc' },
        },
      },
    });
    if (!session) throw new NotFoundException('Training session not found');

    return {
      ...this.toDto(session, session.attendance.length),
      attendees: session.attendance.map((row) => ({
        proId: row.proId,
        fullName: row.pro.fullName,
        enrolledAt: row.enrolledAt,
        attended: row.attended,
        markedAt: row.markedAt,
        markedByAdminId: row.markedByAdminId,
        completionNotes: row.completionNotes,
      })),
    };
  }

  async create(dto: CreateSessionDto): Promise<TrainingSessionDto> {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id: dto.categoryId },
    });
    if (!category) throw new NotFoundException('Service category not found');

    const created = await this.prisma.offlineTrainingSession.create({
      data: {
        categoryId: dto.categoryId,
        title: dto.title,
        venue: dto.venue,
        scheduledAt: new Date(dto.scheduledAt),
        durationMinutes: dto.durationMinutes ?? null,
        trainerName: dto.trainerName ?? null,
        capacity: dto.capacity,
      },
    });
    return this.toDto(created, 0);
  }

  /**
   * Reschedule, retitle, cancel or close a session.
   *
   * Capacity cannot drop below the number already enrolled — the alternative
   * is silently over-subscribing a room, or picking somebody to remove, and
   * neither is a decision this endpoint should make on an admin's behalf.
   */
  async update(id: string, dto: UpdateSessionDto): Promise<TrainingSessionDto> {
    const session = await this.prisma.offlineTrainingSession.findUnique({
      where: { id },
      include: { _count: { select: { attendance: true } } },
    });
    if (!session) throw new NotFoundException('Training session not found');

    if (
      dto.capacity !== undefined &&
      dto.capacity < session._count.attendance
    ) {
      throw apiError(
        `${session._count.attendance} Pros are already enrolled`,
        HttpStatus.CONFLICT,
        [
          {
            field: 'capacity',
            message: 'Remove enrolments first, or keep the capacity',
            code: 'CAPACITY_BELOW_ENROLLED',
          },
        ],
      );
    }

    const updated = await this.prisma.offlineTrainingSession.update({
      where: { id },
      data: {
        ...(dto.title === undefined ? {} : { title: dto.title }),
        ...(dto.venue === undefined ? {} : { venue: dto.venue }),
        ...(dto.scheduledAt === undefined
          ? {}
          : { scheduledAt: new Date(dto.scheduledAt) }),
        ...(dto.durationMinutes === undefined
          ? {}
          : { durationMinutes: dto.durationMinutes }),
        ...(dto.trainerName === undefined
          ? {}
          : { trainerName: dto.trainerName }),
        ...(dto.capacity === undefined ? {} : { capacity: dto.capacity }),
        ...(dto.status === undefined ? {} : { status: dto.status }),
      },
      include: { _count: { select: { attendance: true } } },
    });
    return this.toDto(updated, updated._count.attendance);
  }

  /**
   * Enrol Pros, up to capacity.
   *
   * Already-enrolled ids are skipped rather than rejected, so a bulk enrolment
   * that half-failed can simply be sent again. Going over capacity is refused
   * for the **whole call** rather than filling the remaining seats in id
   * order — an admin who asked for twelve and silently got three has been
   * given a wrong answer that looks like a right one.
   */
  async enrol(
    sessionId: string,
    dto: EnrolProsDto,
  ): Promise<TrainingSessionDto> {
    const session = await this.prisma.offlineTrainingSession.findUnique({
      where: { id: sessionId },
      include: { attendance: { select: { proId: true } } },
    });
    if (!session) throw new NotFoundException('Training session not found');
    if (session.status !== 'scheduled') {
      throw apiError(
        `A ${session.status} session cannot take enrolments`,
        HttpStatus.CONFLICT,
      );
    }

    const already = new Set(session.attendance.map((row) => row.proId));
    const toAdd = [...new Set(dto.proIds)].filter((id) => !already.has(id));

    if (already.size + toAdd.length > session.capacity) {
      throw apiError(
        `Only ${session.capacity - already.size} seats left`,
        HttpStatus.CONFLICT,
        [
          {
            field: 'proIds',
            message: `Asked for ${toAdd.length} new enrolments`,
            code: 'SESSION_FULL',
          },
        ],
      );
    }

    if (toAdd.length > 0) {
      const known = await this.prisma.pro.findMany({
        where: { id: { in: toAdd } },
        select: { id: true },
      });
      if (known.length !== toAdd.length) {
        throw new NotFoundException('One or more Pros were not found');
      }

      await this.prisma.offlineTrainingAttendance.createMany({
        data: toAdd.map((proId) => ({ sessionId, proId })),
        // Belt and braces against two admins enrolling the same Pro at once —
        // the unique index is what actually prevents the duplicate seat.
        skipDuplicates: true,
      });
    }

    return this.get(sessionId);
  }

  /**
   * Mark who turned up.
   *
   * Only for Pros already enrolled: marking someone who walked in unenrolled
   * would create a seat after the fact and put the session over capacity in
   * the record. Enrol them, then mark them.
   */
  async markAttendance(
    sessionId: string,
    adminId: string,
    dto: MarkAttendanceDto,
  ): Promise<TrainingSessionDto> {
    const session = await this.prisma.offlineTrainingSession.findUnique({
      where: { id: sessionId },
      include: { attendance: { select: { proId: true } } },
    });
    if (!session) throw new NotFoundException('Training session not found');

    const enrolled = new Set(session.attendance.map((row) => row.proId));
    const stranger = dto.entries.find((entry) => !enrolled.has(entry.proId));
    if (stranger) {
      throw apiError(
        'That Pro is not enrolled in this session',
        HttpStatus.CONFLICT,
        [
          {
            field: 'entries',
            message: `Pro ${stranger.proId} is not on the list`,
            code: 'NOT_ENROLLED',
          },
        ],
      );
    }

    const now = new Date();
    await this.prisma.$transaction(
      dto.entries.map((entry) =>
        this.prisma.offlineTrainingAttendance.update({
          where: { sessionId_proId: { sessionId, proId: entry.proId } },
          data: {
            attended: entry.attended,
            markedByAdminId: adminId,
            markedAt: now,
            ...(entry.completionNotes === undefined
              ? {}
              : { completionNotes: entry.completionNotes }),
          },
        }),
      ),
    );

    return this.get(sessionId);
  }

  private toDto(
    session: {
      id: string;
      categoryId: string;
      title: string;
      venue: string;
      scheduledAt: Date;
      durationMinutes: number | null;
      trainerName: string | null;
      capacity: number;
      status: string;
    },
    enrolled: number,
  ): TrainingSessionDto {
    return {
      id: session.id,
      categoryId: session.categoryId,
      title: session.title,
      venue: session.venue,
      scheduledAt: session.scheduledAt,
      durationMinutes: session.durationMinutes,
      trainerName: session.trainerName,
      capacity: session.capacity,
      enrolled,
      seatsLeft: Math.max(0, session.capacity - enrolled),
      status: session.status as SessionStatus,
    };
  }
}
