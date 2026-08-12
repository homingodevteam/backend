import { HttpStatus } from '@nestjs/common';
import { CurriculumService } from './curriculum.service';

const NOW = new Date('2026-08-12T09:00:00.000Z');

/** Both branches, because the assertions read whichever one the call took. */
interface UpsertArgs {
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

function aModule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mod-1',
    categoryId: 'cat-1',
    category: { name: 'Electrical' },
    title: 'Isolating a circuit safely',
    description: null,
    contentType: 'video',
    contentKey: 'training/content/abc',
    contentUrl: null,
    contentBytes: 48_000_000,
    version: 3,
    quizAnswerKey: null,
    quizPassPercent: null,
    isMandatory: true,
    durationMinutes: 12,
    sortOrder: 0,
    isActive: true,
    ...overrides,
  };
}

function buildDeps() {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    proTrainingProgress: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn((args: UpsertArgs) =>
        Promise.resolve({
          bestQuizScore: null,
          lockedAt: null,
          ...args.create,
        }),
      ),
    },
  };

  const prisma = {
    // The recursive CTE. Mocked to the answer it would give for cat-1.
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'cat-1' }]),
    proService: {
      findMany: jest.fn().mockResolvedValue([{ serviceId: 'svc-1' }]),
    },
    trainingModule: {
      findFirst: jest.fn().mockResolvedValue(aModule()),
      findMany: jest.fn().mockResolvedValue([aModule()]),
    },
    proTrainingProgress: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn((args: UpsertArgs) =>
        Promise.resolve({
          bestQuizScore: null,
          lockedAt: null,
          ...args.create,
        }),
      ),
    },
    offlineTrainingAttendance: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };

  const s3 = {
    createViewUrl: jest
      .fn()
      .mockResolvedValue({ viewUrl: 'https://s3/get', expiresIn: 21600 }),
  };

  const settings = {
    getNumber: jest.fn((_key: string, fallback: number) =>
      Promise.resolve(fallback),
    ),
    getString: jest.fn().mockResolvedValue(null),
  };

  return { prisma, tx, s3, settings };
}

function build(deps: ReturnType<typeof buildDeps>): CurriculumService {
  return new CurriculumService(
    deps.prisma as never,
    deps.s3 as never,
    deps.settings as never,
  );
}

beforeAll(() => {
  jest.useFakeTimers().setSystemTime(NOW);
});
afterAll(() => {
  jest.useRealTimers();
});

// =====================================================================
// Derivation
// =====================================================================

describe('curriculum', () => {
  it('derives from the Pro’s ACTIVE services only', async () => {
    const deps = buildDeps();

    await build(deps).curriculum('pro-1');

    expect(deps.prisma.proService.findMany.mock.calls[0][0].where).toEqual({
      proId: 'pro-1',
      isActive: true,
    });
  });

  it('returns nothing rather than everything for a Pro with no services', async () => {
    const deps = buildDeps();
    deps.prisma.proService.findMany.mockResolvedValue([]);

    const result = await build(deps).curriculum('pro-1');

    // The dangerous failure here is an empty id list widening to "all
    // categories" — every Pro would see every trade's training.
    expect(deps.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(result.modules).toEqual([]);
  });

  it('narrows to one trade when a serviceId is given', async () => {
    const deps = buildDeps();

    await build(deps).curriculum('pro-1', 'svc-9');

    expect(
      deps.prisma.proService.findMany.mock.calls[0][0].where,
    ).toMatchObject({ serviceId: 'svc-9' });
  });

  it('counts outstanding mandatory modules', async () => {
    const deps = buildDeps();
    deps.prisma.trainingModule.findMany.mockResolvedValue([
      aModule({ id: 'mod-1', isMandatory: true }),
      aModule({ id: 'mod-2', isMandatory: true }),
      aModule({ id: 'mod-3', isMandatory: false }),
    ]);
    deps.prisma.proTrainingProgress.findMany.mockResolvedValue([
      { moduleId: 'mod-1', status: 'completed', quizAttempts: 0 },
    ]);

    const result = await build(deps).curriculum('pro-1');

    expect(result).toMatchObject({
      total: 3,
      completed: 1,
      mandatoryOutstanding: 1,
    });
  });

  /** A Pro with no activity has no rows at all, not one per module. */
  it('fills in defaults for a module never opened', async () => {
    const deps = buildDeps();

    const { modules } = await build(deps).curriculum('pro-1');

    expect(modules[0]).toMatchObject({
      status: 'not_started',
      percentComplete: 0,
      lastPositionSeconds: 0,
      bestQuizScore: null,
      isLocked: false,
    });
  });
});

// =====================================================================
// The answer key
// =====================================================================

describe('the quiz answer key', () => {
  /**
   * The property, not the implementation: serialise what a Pro receives and
   * look for the answers. "We remembered not to include it" does not survive
   * the next person adding a field with a spread.
   */
  it('never reaches a Pro, in any field of the response', async () => {
    const deps = buildDeps();
    const module = aModule({
      contentType: 'quiz',
      quizAnswerKey: { q1: 'b', q2: ['a', 'c'] },
    });
    deps.prisma.trainingModule.findFirst.mockResolvedValue(module);
    deps.prisma.trainingModule.findMany.mockResolvedValue([module]);

    const detail = await build(deps).moduleDetail('pro-1', 'mod-1');
    const serialised = JSON.stringify(detail);

    expect(serialised).not.toContain('quizAnswerKey');
    // The answers themselves, not merely the field name.
    expect(detail.quizQuestionIds).toEqual(['q1', 'q2']);
    expect(serialised).not.toContain('"b"');
  });
});

// =====================================================================
// Content URLs
// =====================================================================

describe('content', () => {
  it('signs an uploaded object for six hours, not five minutes', async () => {
    const deps = buildDeps();

    await build(deps).moduleDetail('pro-1', 'mod-1');

    expect(deps.s3.createViewUrl).toHaveBeenCalledWith(
      'training/content/abc',
      6 * 60 * 60,
    );
  });

  it('passes an externally hosted URL straight through', async () => {
    const deps = buildDeps();
    const module = aModule({
      contentKey: null,
      contentUrl: 'https://example.com/video.mp4',
    });
    deps.prisma.trainingModule.findFirst.mockResolvedValue(module);
    deps.prisma.trainingModule.findMany.mockResolvedValue([module]);

    const detail = await build(deps).moduleDetail('pro-1', 'mod-1');

    expect(detail.contentUrl).toBe('https://example.com/video.mp4');
    expect(deps.s3.createViewUrl).not.toHaveBeenCalled();
  });

  it('404s a module outside the Pro’s trades', async () => {
    const deps = buildDeps();
    deps.prisma.trainingModule.findFirst.mockResolvedValue(
      aModule({ categoryId: 'cat-other' }),
    );

    await expect(
      build(deps).moduleDetail('pro-1', 'mod-1'),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });
});

describe('manifest', () => {
  it('flags a large file for wifi and carries the version', async () => {
    const deps = buildDeps();

    const manifest = await build(deps).manifest('pro-1');

    expect(manifest.modules[0]).toMatchObject({
      version: 3,
      bytes: 48_000_000,
      wifiRecommended: true,
    });
    expect(manifest.totalBytes).toBe(48_000_000);
  });

  it('does not push a small doc onto wifi', async () => {
    const deps = buildDeps();
    deps.prisma.trainingModule.findMany.mockResolvedValue([
      aModule({ contentType: 'doc', contentBytes: 200_000 }),
    ]);

    const manifest = await build(deps).manifest('pro-1');

    expect(manifest.modules[0].wifiRecommended).toBe(false);
  });
});

// =====================================================================
// Progress
// =====================================================================

describe('updateProgress', () => {
  it('completes a video at 100%', async () => {
    const deps = buildDeps();

    const item = await build(deps).updateProgress('pro-1', 'mod-1', {
      percentComplete: 100,
    });

    expect(item.status).toBe('completed');
  });

  /** Scrubbing back through a video must not undo a completion. */
  it('never moves percentComplete backwards', async () => {
    const deps = buildDeps();
    deps.prisma.proTrainingProgress.findUnique.mockResolvedValue({
      moduleId: 'mod-1',
      status: 'completed',
      percentComplete: 100,
      lastPositionSeconds: 700,
      quizAttempts: 0,
      completedAt: new Date('2026-08-01T00:00:00.000Z'),
      startedAt: new Date('2026-08-01T00:00:00.000Z'),
      bestQuizScore: null,
      lockedAt: null,
    });

    await build(deps).updateProgress('pro-1', 'mod-1', {
      percentComplete: 10,
      lastPositionSeconds: 30,
    });

    const { update } = deps.prisma.proTrainingProgress.upsert.mock.calls[0][0];
    expect(update.percentComplete).toBe(100);
    expect(update.status).toBe('completed');
    // The resume point IS allowed to move back — that is what it is for.
    expect(update.lastPositionSeconds).toBe(30);
    // And the completion date stays where it was.
    expect(update.completedAt).toEqual(new Date('2026-08-01T00:00:00.000Z'));
  });

  /** Feature 4: the score is the signal, not percent watched. */
  it('will not complete a quiz by watching it', async () => {
    const deps = buildDeps();
    const module = aModule({
      contentType: 'quiz',
      quizAnswerKey: { q1: 'a' },
    });
    deps.prisma.trainingModule.findFirst.mockResolvedValue(module);
    deps.prisma.trainingModule.findMany.mockResolvedValue([module]);

    const item = await build(deps).updateProgress('pro-1', 'mod-1', {
      percentComplete: 100,
    });

    expect(item.status).toBe('in_progress');
  });
});

// =====================================================================
// Quizzes
// =====================================================================

describe('submitQuiz', () => {
  function withQuiz(
    deps: ReturnType<typeof buildDeps>,
    overrides: Record<string, unknown> = {},
  ) {
    const module = aModule({
      contentType: 'quiz',
      quizAnswerKey: { q1: 'a', q2: 'b' },
      ...overrides,
    });
    deps.prisma.trainingModule.findFirst.mockResolvedValue(module);
    deps.prisma.trainingModule.findMany.mockResolvedValue([module]);
  }

  it('passes at or above the mark and completes the module', async () => {
    const deps = buildDeps();
    withQuiz(deps);

    const result = await build(deps).submitQuiz('pro-1', 'mod-1', {
      answers: { q1: 'a', q2: 'b' },
    });

    expect(result).toMatchObject({ score: 100, passed: true, isLocked: false });
    // Passing stops the attempt counter mattering.
    expect(result.attemptsLeft).toBeNull();
    expect(
      deps.tx.proTrainingProgress.upsert.mock.calls[0][0].update.status,
    ).toBe('completed');
  });

  /**
   * Both directions, because a per-module override that only ever tightens is
   * indistinguishable from no override at all.
   */
  it('honours a per-module pass mark stricter than the platform default', async () => {
    const deps = buildDeps();
    // Platform default 50: this attempt would pass without the override.
    deps.settings.getNumber.mockImplementation(
      (key: string, fallback: number) =>
        Promise.resolve(key === 'training.quizPassPercent' ? 50 : fallback),
    );
    withQuiz(deps, { quizPassPercent: 100 });

    const result = await build(deps).submitQuiz('pro-1', 'mod-1', {
      answers: { q1: 'a', q2: 'wrong' },
    });

    expect(result).toMatchObject({ score: 50, passed: false });
  });

  it('honours a per-module pass mark looser than the platform default', async () => {
    const deps = buildDeps();
    // Platform default 70: this attempt would fail without the override.
    withQuiz(deps, { quizPassPercent: 50 });

    const result = await build(deps).submitQuiz('pro-1', 'mod-1', {
      answers: { q1: 'a', q2: 'wrong' },
    });

    expect(result).toMatchObject({ score: 50, passed: true });
  });

  it('locks on the attempt that exhausts the cap, not the one after', async () => {
    const deps = buildDeps();
    withQuiz(deps);
    deps.settings.getNumber.mockImplementation(
      (key: string, fallback: number) =>
        Promise.resolve(key === 'training.maxQuizAttempts' ? 2 : fallback),
    );
    deps.tx.proTrainingProgress.findUnique.mockResolvedValue({
      quizAttempts: 1,
      status: 'in_progress',
      percentComplete: 0,
      bestQuizScore: 50,
      lockedAt: null,
      startedAt: NOW,
      completedAt: null,
    });

    const result = await build(deps).submitQuiz('pro-1', 'mod-1', {
      answers: { q1: 'wrong', q2: 'wrong' },
    });

    // attemptsLeft and isLocked must agree — a "0 left, not locked" state is
    // a screen offering a button that 409s.
    expect(result).toMatchObject({
      attemptsUsed: 2,
      attemptsLeft: 0,
      isLocked: true,
    });
  });

  it('refuses an attempt once locked', async () => {
    const deps = buildDeps();
    withQuiz(deps);
    deps.tx.proTrainingProgress.findUnique.mockResolvedValue({
      quizAttempts: 3,
      lockedAt: NOW,
    });

    await expect(
      build(deps).submitQuiz('pro-1', 'mod-1', { answers: { q1: 'a' } }),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
  });

  /** A worse retake must not un-qualify somebody who already passed. */
  it('keeps the best score across attempts', async () => {
    const deps = buildDeps();
    withQuiz(deps);
    deps.tx.proTrainingProgress.findUnique.mockResolvedValue({
      quizAttempts: 1,
      status: 'completed',
      percentComplete: 100,
      bestQuizScore: 100,
      lockedAt: null,
      startedAt: NOW,
      completedAt: NOW,
    });

    const result = await build(deps).submitQuiz('pro-1', 'mod-1', {
      answers: { q1: 'a', q2: 'wrong' },
    });

    expect(result.score).toBe(50);
    expect(result.bestQuizScore).toBe(100);
  });

  it('refuses a module that is not a quiz', async () => {
    const deps = buildDeps();

    await expect(
      build(deps).submitQuiz('pro-1', 'mod-1', { answers: {} }),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
  });

  /**
   * A broken key grades every attempt at zero, which reads to the Pro as their
   * own failure. Refuse, and burn no attempt.
   */
  it('refuses a quiz whose key is malformed, without consuming an attempt', async () => {
    const deps = buildDeps();
    withQuiz(deps, { quizAnswerKey: { q1: 42 } });

    await expect(
      build(deps).submitQuiz('pro-1', 'mod-1', { answers: { q1: 'a' } }),
    ).rejects.toMatchObject({ status: HttpStatus.UNPROCESSABLE_ENTITY });
    expect(deps.tx.proTrainingProgress.upsert).not.toHaveBeenCalled();
  });

  it('serialises attempts per Pro and module', async () => {
    const deps = buildDeps();
    withQuiz(deps);

    await build(deps).submitQuiz('pro-1', 'mod-1', { answers: { q1: 'a' } });

    expect(deps.tx.$executeRaw.mock.calls[0][1]).toBe('quiz:pro-1:mod-1');
  });
});

// =====================================================================
// Eligibility
// =====================================================================

describe('missingMandatory', () => {
  it('names the modules that are outstanding', async () => {
    const deps = buildDeps();
    deps.prisma.trainingModule.findMany.mockResolvedValue([
      { id: 'mod-1', title: 'Isolating a circuit safely' },
      { id: 'mod-2', title: 'Ladder safety' },
    ]);
    deps.prisma.proTrainingProgress.findMany.mockResolvedValue([
      { moduleId: 'mod-2' },
    ]);

    expect(await build(deps).missingMandatory('pro-1', 'svc-1')).toEqual([
      'Isolating a circuit safely',
    ]);
  });

  it('passes a trade with no mandatory modules at all', async () => {
    const deps = buildDeps();
    deps.prisma.trainingModule.findMany.mockResolvedValue([]);

    expect(await build(deps).missingMandatory('pro-1', 'svc-1')).toEqual([]);
  });
});

describe('gateEnforced', () => {
  /** Ships off, so a gate cannot block onboarding before content exists. */
  it('is off when nobody has set it', async () => {
    const deps = buildDeps();

    expect(await build(deps).gateEnforced(null)).toBe(false);
  });

  it('is on only for the exact string "true"', async () => {
    const deps = buildDeps();
    deps.settings.getString.mockResolvedValue('true');
    expect(await build(deps).gateEnforced('city-1')).toBe(true);

    deps.settings.getString.mockResolvedValue('yes');
    expect(await build(deps).gateEnforced('city-1')).toBe(false);
  });
});
