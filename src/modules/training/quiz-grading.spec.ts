import {
  answerMatches,
  gradeQuiz,
  questionIdsFrom,
  readAnswerKey,
} from './quiz-grading';

describe('answerMatches', () => {
  it('matches a single answer', () => {
    expect(answerMatches('b', 'b')).toBe(true);
    expect(answerMatches('b', 'c')).toBe(false);
  });

  it('is not fooled by case or padding', () => {
    expect(answerMatches('B', ' b ')).toBe(true);
  });

  /** "a, c" and "c, a" are the same answer and no UI should have to promise otherwise. */
  it('ignores order in a multi-select', () => {
    expect(answerMatches(['a', 'c'], ['c', 'a'])).toBe(true);
  });

  it('ignores a duplicate the client sent twice', () => {
    expect(answerMatches(['a', 'c'], ['a', 'c', 'a'])).toBe(true);
  });

  it('rejects a partial multi-select', () => {
    expect(answerMatches(['a', 'c'], ['a'])).toBe(false);
  });

  it('rejects an over-answered multi-select', () => {
    expect(answerMatches(['a'], ['a', 'b'])).toBe(false);
  });

  /** Whichever shape a client happens to use is not part of what is assessed. */
  it('treats a one-element array and a bare string as the same answer', () => {
    expect(answerMatches('a', ['a'])).toBe(true);
    expect(answerMatches(['a'], 'a')).toBe(true);
  });

  it('counts an unanswered question as wrong', () => {
    expect(answerMatches('a', undefined)).toBe(false);
  });
});

describe('gradeQuiz', () => {
  const key = { q1: 'a', q2: 'b', q3: ['x', 'y'] };

  it('scores a perfect attempt', () => {
    expect(gradeQuiz(key, { q1: 'a', q2: 'b', q3: ['y', 'x'] })).toEqual({
      score: 100,
      correct: 3,
      total: 3,
      incorrectQuestionIds: [],
    });
  });

  it('names what was wrong, for a "review these" screen', () => {
    const result = gradeQuiz(key, { q1: 'a', q2: 'z', q3: ['x'] });
    expect(result.correct).toBe(1);
    expect(result.incorrectQuestionIds).toEqual(['q2', 'q3']);
  });

  it('rounds to two places rather than carrying a float', () => {
    // 2/3 → 66.666… A stored 66.66666666666667 compared against a 70% pass
    // mark works, but it displays as noise and serialises differently every
    // time the DECIMAL(5,2) column round-trips.
    expect(gradeQuiz(key, { q1: 'a', q2: 'b', q3: 'wrong' }).score).toBe(66.67);
  });

  /**
   * The denominator comes from the KEY, never from the submission — otherwise
   * a client could score 100% by answering only the one question it knew.
   */
  it('counts omitted questions against the score', () => {
    expect(gradeQuiz(key, { q1: 'a' })).toMatchObject({
      correct: 1,
      total: 3,
      score: 33.33,
    });
  });

  it('ignores answers to questions the quiz does not have', () => {
    expect(gradeQuiz({ q1: 'a' }, { q1: 'a', q99: 'whatever' })).toMatchObject({
      score: 100,
      total: 1,
    });
  });

  it('scores an empty key at zero rather than dividing by it', () => {
    expect(gradeQuiz({}, {})).toMatchObject({ score: 0, total: 0 });
  });
});

describe('readAnswerKey', () => {
  it('accepts single and multi-select entries', () => {
    expect(readAnswerKey({ q1: 'a', q2: ['b', 'c'] })).toEqual({
      q1: 'a',
      q2: ['b', 'c'],
    });
  });

  /**
   * A malformed key would grade every attempt at zero and read to the Pro as
   * their own failure. Null makes the endpoint refuse and burn no attempt.
   */
  it.each([
    ['null', null],
    ['an array', ['a', 'b']],
    ['a string', 'q1=a'],
    ['an empty object', {}],
    ['a numeric answer', { q1: 3 }],
    ['a mixed array', { q1: ['a', 7] }],
  ])('returns null for %s', (_label, value) => {
    expect(readAnswerKey(value)).toBeNull();
  });
});

describe('questionIdsFrom', () => {
  it('keeps key order, which is the order the app renders', () => {
    expect(questionIdsFrom({ q3: 'a', q1: 'b', q2: 'c' })).toEqual([
      'q3',
      'q1',
      'q2',
    ]);
  });
});
