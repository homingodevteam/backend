/**
 * Grading a quiz attempt.
 *
 * Pure and on its own so it can be tested exhaustively without a database,
 * because this is the function that decides whether a Pro is competent to be
 * sent to a customer's home.
 *
 * ## Why the server grades
 *
 * Feature 4 says the score is the defensible signal, not percent watched. A
 * score the Pro's own phone computed is not defensible — it is a number the
 * client chose. So the questions are served without their answers, the app
 * sends back what was picked, and the comparison happens here.
 *
 * `TrainingModule.quizAnswerKey` is never in a Pro-facing DTO. There is a spec
 * that serialises a module through the Pro DTO and fails if the string appears
 * anywhere in the JSON, because "we remembered not to include it" is not a
 * property that survives the next person adding a field.
 */

/** One right answer, or a set of them for a multi-select question. */
export type AnswerValue = string | string[];
export type AnswerKey = Record<string, AnswerValue>;
export type Submission = Record<string, AnswerValue>;

export interface GradeResult {
  /** 0–100, two decimal places. */
  score: number;
  correct: number;
  total: number;
  /** Question ids answered wrongly or not at all — for a "review these" screen. */
  incorrectQuestionIds: string[];
}

/**
 * True when a submitted answer matches the key.
 *
 * Order-insensitive and duplicate-insensitive for multi-select, because "a, c"
 * and "c, a" are the same answer and no UI should have to guarantee otherwise.
 * A single-value key sent as a one-element array counts, and vice versa — the
 * shape a client happens to use is not part of what is being assessed.
 */
export function answerMatches(
  expected: AnswerValue,
  submitted: AnswerValue | undefined,
): boolean {
  if (submitted === undefined) return false;

  const normalise = (value: AnswerValue): string[] => {
    const list = Array.isArray(value) ? value : [value];
    return [
      ...new Set(
        list
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim().toLowerCase()),
      ),
    ].sort();
  };

  const left = normalise(expected);
  const right = normalise(submitted);
  if (left.length === 0 || left.length !== right.length) return false;
  return left.every((entry, index) => entry === right[index]);
}

/**
 * Grade a submission against an answer key.
 *
 * **The key is what defines the quiz.** Questions the key does not mention are
 * ignored no matter what the app sent, and questions the key does mention are
 * counted whether or not an answer arrived — an unanswered question is wrong,
 * not absent. That asymmetry is deliberate: it means a client cannot shrink
 * the denominator by omitting the questions it does not know.
 */
export function gradeQuiz(
  answerKey: AnswerKey,
  submission: Submission,
): GradeResult {
  const questionIds = Object.keys(answerKey);
  const total = questionIds.length;

  const incorrectQuestionIds = questionIds.filter(
    (id) => !answerMatches(answerKey[id], submission[id]),
  );
  const correct = total - incorrectQuestionIds.length;

  return {
    // A quiz with no questions scores zero rather than dividing by it. The
    // database CHECK stops an empty key reaching here, so this is a floor
    // rather than a path anyone should hit.
    score: total === 0 ? 0 : Math.round((correct / total) * 10000) / 100,
    correct,
    total,
    incorrectQuestionIds,
  };
}

/**
 * A stored `Json` column narrowed to an answer key, or null if it is not one.
 *
 * Anything that is not `{ id: string | string[] }` is treated as absent rather
 * than coerced. A malformed key would otherwise grade every attempt as zero
 * and read to the Pro as their own failure.
 */
export function readAnswerKey(value: unknown): AnswerKey | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;

  const key: AnswerKey = {};
  for (const [questionId, expected] of entries) {
    if (typeof expected === 'string') {
      key[questionId] = expected;
    } else if (
      Array.isArray(expected) &&
      expected.every((entry) => typeof entry === 'string')
    ) {
      key[questionId] = expected;
    } else {
      return null;
    }
  }
  return key;
}

/** The question ids a Pro's app should render, taken from the key's shape. */
export function questionIdsFrom(answerKey: AnswerKey): string[] {
  return Object.keys(answerKey);
}
