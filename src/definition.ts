import type { WorldDefinition } from 'cortico/world.ts';
import { OVERCOOKED2_DEFAULTS, type Overcooked2ConfigSection } from './config.ts';
import { Overcooked2World } from './world.ts';

export const OVERCOOKED2: WorldDefinition<Overcooked2ConfigSection> = {
  id: 'overcooked2',
  label: '胡闹厨房 2',
  defaults: () => structuredClone(OVERCOOKED2_DEFAULTS),
  create: ctx => new Overcooked2World({ cfg: ctx.cfg, timezone: ctx.timezone }),
};
