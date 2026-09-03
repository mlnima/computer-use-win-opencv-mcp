import { z } from 'zod';

const lease = { leaseId: z.string().optional() };
const pointTarget = {
  observationId: z.string().min(1),
  token: z.string().min(1),
  elementId: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  allowRaw: z.boolean().default(false)
};

export const preparePointerSchema = z.object({
  ...pointTarget,
  ...lease,
  durationMs: z.number().int().min(0).max(10000).default(180),
  verification: z.enum(['geometry', 'visual', 'none']).default('visual'),
  hoverScreenshot: z.boolean().default(true)
});

export const commitPointerSchema = z.object({
  ...lease,
  prepareId: z.string().min(1),
  action: z.enum(['click', 'doubleClick', 'tripleClick', 'rightClick', 'middleClick', 'x1Click', 'x2Click', 'scroll']).default('click'),
  deltaX: z.number().int().optional(),
  deltaY: z.number().int().optional(),
  observeAfter: z.boolean().default(true)
});

export const rawPointerSchema = z.object({
  ...lease,
  action: z.enum(['move', 'click', 'button', 'scroll']),
  x: z.number().optional(),
  y: z.number().optional(),
  relative: z.boolean().default(false),
  durationMs: z.number().int().min(0).max(10000).default(0),
  steps: z.number().int().min(1).max(600).optional(),
  button: z.enum(['left', 'right', 'middle', 'x1', 'x2']).default('left'),
  mode: z.enum(['press', 'down', 'up']).default('press'),
  count: z.number().int().min(1).max(10).default(1),
  intervalMs: z.number().int().min(0).max(2000).default(80),
  deltaX: z.number().int().optional(),
  deltaY: z.number().int().optional()
});

export const keyboardSchema = z.object({
  ...lease,
  action: z.enum(['key', 'chord', 'text']),
  key: z.string().optional(),
  keys: z.array(z.string()).max(32).optional(),
  text: z.string().max(100000).optional(),
  mode: z.enum(['press', 'down', 'up']).default('press'),
  method: z.enum(['virtual-key', 'scan-code']).default('virtual-key'),
  holdMs: z.number().int().min(0).max(10000).default(0),
  intervalMs: z.number().int().min(0).max(2000).default(0),
  windowHandle: z.string().optional()
});

const moveEvent = z.object({
  at: z.number().nonnegative(),
  type: z.literal('move'),
  x: z.number(),
  y: z.number(),
  duration: z.number().nonnegative().optional(),
  relative: z.boolean().optional()
});

const buttonEvent = z.object({
  at: z.number().nonnegative(),
  type: z.literal('button'),
  button: z.enum(['left', 'right', 'middle', 'x1', 'x2']),
  mode: z.enum(['press', 'down', 'up'])
});

const keyEvent = z.object({
  at: z.number().nonnegative(),
  type: z.literal('key'),
  key: z.string().min(1),
  mode: z.enum(['press', 'down', 'up'])
});

const textEvent = z.object({
  at: z.number().nonnegative(),
  type: z.literal('text'),
  text: z.string().max(100000)
});

const wheelEvent = z.object({
  at: z.number().nonnegative(),
  type: z.literal('wheel'),
  deltaX: z.number().optional(),
  deltaY: z.number().optional()
});

export const timelineSchema = z.object({
  ...lease,
  events: z.array(z.discriminatedUnion('type', [moveEvent, buttonEvent, keyEvent, textEvent, wheelEvent])),
  keyMethod: z.enum(['virtual-key', 'scan-code']).default('scan-code'),
  preserveHeld: z.boolean().default(false),
  windowHandle: z.string().optional()
});

export const dragBeginSchema = z.object({
  ...lease,
  prepareId: z.string().min(1),
  button: z.enum(['left', 'right', 'middle', 'x1', 'x2']).default('left')
});

export const dragMoveSchema = z.object({
  ...lease,
  dragId: z.string().min(1),
  observationId: z.string().optional(),
  token: z.string().optional(),
  elementId: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  screenCoordinates: z.boolean().default(false),
  relative: z.boolean().default(false),
  allowRaw: z.boolean().default(false),
  durationMs: z.number().int().min(0).max(10000).default(300),
  hoverScreenshot: z.boolean().default(true)
});

export const dragReleaseSchema = z.object({
  ...lease,
  dragId: z.string().min(1),
  observeAfter: z.boolean().default(true)
});

export const accessibilitySchema = z.object({
  ...lease,
  observationId: z.string().optional(),
  token: z.string().optional(),
  elementId: z.string().optional(),
  windowHandle: z.string().optional(),
  runtimeId: z.string().optional(),
  action: z.enum(['focus', 'invoke', 'click', 'setValue', 'toggle', 'select', 'expand', 'collapse', 'scroll']),
  value: z.string().optional(),
  observeAfter: z.boolean().default(true)
});
