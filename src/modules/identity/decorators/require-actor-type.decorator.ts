import { SetMetadata } from '@nestjs/common';
import type { ActorType } from '../../../common/types/authenticated-user.type';

export const ACTOR_TYPE_KEY = 'requiredActorType';

/** Restricts a route to one actor type — e.g. a Pro token can't hit /customers/me. */
export const RequireActorType = (actorType: ActorType) =>
  SetMetadata(ACTOR_TYPE_KEY, actorType);
