import { Injectable, Logger } from '@nestjs/common';

export const TRAINING_GATE_PORT = Symbol('TRAINING_GATE_PORT');

/**
 * What Pro Management needs from Training (module 10), expressed as an
 * interface Pro Management owns.
 *
 * Feature 6: a Pro cannot be activated for a service until the mandatory
 * modules for that service's trade are complete. The decision point is
 * `ProServiceAssignmentsService` — `assign()`, which creates a row already
 * active, and `update()`, which can flip one to active — and neither of those
 * can reach into module 10's tables without a dependency this module does not
 * want.
 *
 * Seventh use of the pattern in this codebase: the consumer owns the interface
 * and a no-op, the provider registers itself at boot, and nothing here changes
 * when module 10 appears or is removed.
 */
export interface TrainingGatePort {
  /**
   * Throw if this Pro has not finished the mandatory training for this
   * service. Return quietly otherwise.
   *
   * **Implementations decide for themselves whether the gate is on.** The
   * switch is `training.gateActivation`, which ships off, and putting that
   * check on this side would mean module 6 owning a module 10 setting.
   *
   * Whatever is thrown must name what is missing. "Not eligible" with no list
   * is a support ticket somebody has to work out from first principles.
   */
  assertEligible(proId: string, serviceId: string): Promise<void>;
}

/**
 * Stand-in until module 10 lands, and the delegate it registers into.
 *
 * **Allows everything.** This is the one no-op in the codebase whose fallback
 * is deliberately permissive rather than merely quiet: the alternative —
 * refusing activations when the training module is absent — would mean a
 * deployment without module 10 cannot onboard a single Pro. A missing gate is
 * a control that is not being applied; a gate that fails closed with nothing
 * behind it is an outage.
 */
@Injectable()
export class NoOpTrainingGateService implements TrainingGatePort {
  private readonly logger = new Logger(NoOpTrainingGateService.name);

  private real: TrainingGatePort | null = null;

  register(implementation: TrainingGatePort): void {
    this.real = implementation;
    this.logger.log(
      'Training gate registered — mandatory-module checks can now run on ' +
        'service activation (subject to training.gateActivation).',
    );
  }

  get isRegistered(): boolean {
    return this.real !== null;
  }

  assertEligible(proId: string, serviceId: string): Promise<void> {
    if (this.real) return this.real.assertEligible(proId, serviceId);
    return Promise.resolve();
  }
}
