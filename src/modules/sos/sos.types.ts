/**
 * Module 11 · Safety — the vocabulary.
 *
 * Three statuses and no more. `false_alarm` is a normal ending, not a lesser
 * one: nothing in this module counts them, rate-limits on them, or surfaces
 * them back on the customer's account. Hesitating to press the button because
 * of what happens if you are wrong is the failure this feature exists to
 * prevent — US-11.4 — and a schema that recorded false alarms as a distinct
 * kind of mistake would be the first step toward penalising them.
 */
export const SOS_STATUSES = ['active', 'false_alarm', 'closed'] as const;
export type SosStatus = (typeof SOS_STATUSES)[number];

/**
 * How long a fix may be before ops should stop trusting it as "where they are
 * now", in minutes.
 *
 * Not enforced — an old fix is still the best information available and is
 * never grounds to reject an alarm. It is a display rule: the console marks
 * anything older than this as stale so a dispatcher does not send help to
 * where somebody was an hour ago.
 */
export const STALE_FIX_MINUTES = 10;
