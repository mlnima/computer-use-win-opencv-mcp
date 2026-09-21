import { z } from 'zod';

const lease = { leaseId: z.string().describe('Required input lease ID returned by computer_control action acquire. Renew it before it expires.') };
const surface = z.object({ observationId: z.string().min(1), token: z.string().min(1), elementId: z.string().optional() }).optional().describe('Required for raw pointer presses, scrolling, or drawing. Scrolling permits normal UI elements; clicks and drawing require a canvas element or tightly bounded region. Keep all points at least 8 screen pixels inside its bounds.');
const wheel = {
  deltaX: z.number().int().optional().describe('Windows wheel units: 120 per notch. Positive scrolls right; negative scrolls left.'),
  deltaY: z.number().int().optional().describe('Windows wheel units: 120 per notch. Positive scrolls up; negative scrolls down.')
};
const nonzeroWheel = { anyOf: [
  { required: ['deltaX'], properties: { deltaX: { not: { const: 0 } } } },
  { required: ['deltaY'], properties: { deltaY: { not: { const: 0 } } } }
] };
const pointTarget = {
  observationId: z.string().min(1),
  token: z.string().min(1),
  elementId: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  allowRaw: z.boolean().default(false).describe('Only for explicitly identified visual surfaces or canvas coordinates. Never use to bypass a rejected control target.')
};

export const preparePointerSchema = z.object({
  ...pointTarget,
  ...lease,
  durationMs: z.number().int().min(0).max(10000).default(180),
  verification: z.literal('visual').default('visual'),
  hoverScreenshot: z.boolean().default(true)
});

export const commitPointerSchema = z.object({
  ...lease,
  prepareId: z.string().min(1),
  action: z.enum(['click', 'doubleClick', 'tripleClick', 'rightClick', 'middleClick', 'x1Click', 'x2Click', 'scroll']).default('click'),
  ...wheel,
  observeAfter: z.boolean().default(true),
  inlineImage: z.boolean().optional().describe('Include the post-action screenshot. By default, compact local elements replace images when semantic controls are available.')
}).superRefine((input, context) => {
  if (input.action === 'scroll' && !input.deltaX && !input.deltaY) context.addIssue({ code: 'custom', path: ['deltaY'], message: 'Scrolling requires nonzero deltaX or deltaY, in Windows wheel units (120 per notch).' });
}).meta({ allOf: [{ if: { required: ['action'], properties: { action: { const: 'scroll' } } }, then: nonzeroWheel }] });

export const rawPointerSchema = z.object({
  ...lease,
  surface,
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
  ...wheel
}).superRefine((input, context) => {
  if ((input.x === undefined) !== (input.y === undefined) || ((input.action === 'move' || input.relative) && input.x === undefined)) context.addIssue({ code: 'custom', path: ['x'], message: 'Supply both x and y for a move or relative input; otherwise omit both to use the current point (or the supplied scroll surface).' });
  if ((input.action === 'click' || input.action === 'scroll' || input.action === 'button' && input.mode !== 'up') && !input.surface) context.addIssue({ code: 'custom', path: ['surface'], message: 'Provide a fresh observed surface for pointer presses or scrolling.' });
  if (input.action === 'scroll' && !input.deltaX && !input.deltaY) context.addIssue({ code: 'custom', path: ['deltaY'], message: 'Scrolling requires nonzero deltaX or deltaY, in Windows wheel units (120 per notch).' });
}).meta({ allOf: [
  { if: { required: ['x'] }, then: { required: ['y'] } },
  { if: { required: ['y'] }, then: { required: ['x'] } },
  { if: { properties: { action: { const: 'move' } } }, then: { required: ['x', 'y'] } },
  { if: { required: ['relative'], properties: { relative: { const: true } } }, then: { required: ['x', 'y'] } },
  { if: { properties: { action: { enum: ['click', 'scroll'] } } }, then: { required: ['surface'] } },
  { if: { properties: { action: { const: 'button' } }, not: { required: ['mode'], properties: { mode: { const: 'up' } } } }, then: { required: ['surface'] } },
  { if: { properties: { action: { const: 'scroll' } } }, then: nonzeroWheel }
] });

export const keyboardSchema = z.object({
  ...lease,
  action: z.enum(['key', 'chord', 'text']),
  key: z.string().min(1).optional().describe('Required for action key. Use letters, digits, F1-F24, named keys such as PageDown/PageUp (NEXT/PRIOR), or vk:/scan: numeric codes.'),
  keys: z.array(z.string().min(1)).min(1).max(32).optional().describe('Required for action chord, for example ["Control", "a"].'),
  text: z.string().max(100000).optional(),
  mode: z.enum(['press', 'down', 'up']).default('press'),
  method: z.enum(['virtual-key', 'scan-code']).default('virtual-key'),
  holdMs: z.number().int().min(0).max(10000).default(0),
  intervalMs: z.number().int().min(0).max(2000).default(0),
  windowHandle: z.string().optional()
}).superRefine((input, context) => {
  const field = input.action === 'chord' ? 'keys' : input.action;
  if (input[field] === undefined) context.addIssue({ code: 'custom', path: [field], message: `${field} is required for action ${input.action}.` });
}).meta({ anyOf: [
  { properties: { action: { const: 'key' } }, required: ['key'] },
  { properties: { action: { const: 'chord' } }, required: ['keys'] },
  { properties: { action: { const: 'text' } }, required: ['text'] }
] });

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
  ...wheel
}).superRefine((input, context) => {
  if (!input.deltaX && !input.deltaY) context.addIssue({ code: 'custom', path: ['deltaY'], message: 'Wheel events require nonzero deltaX or deltaY (120 units per notch).' });
}).meta(nonzeroWheel);

export const timelineSchema = z.object({
  ...lease,
  surface,
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
  observationId: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
  elementId: z.string().min(1).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  screenCoordinates: z.boolean().default(false),
  relative: z.boolean().default(false).describe('Move by x/y deltas from the current pointer. A missing axis is zero. Cannot be combined with observationId or screenCoordinates.'),
  allowRaw: z.boolean().default(false),
  durationMs: z.number().int().min(0).max(10000).default(300),
  hoverScreenshot: z.boolean().default(true)
}).superRefine((input, context) => {
  const grounded = input.observationId && input.token && !input.relative && !input.screenCoordinates && (input.elementId || input.allowRaw && input.x !== undefined && input.y !== undefined);
  const absolute = !input.observationId && input.screenCoordinates && !input.relative && input.x !== undefined && input.y !== undefined;
  const relative = !input.observationId && input.relative && !input.screenCoordinates && (input.x !== undefined || input.y !== undefined);
  if (!grounded && !absolute && !relative) context.addIssue({ code: 'custom', message: 'Provide observationId/token with elementId (or allowRaw and x/y), screenCoordinates with x/y, or relative with at least one of x/y. Do not mix coordinate modes.' });
}).meta({ anyOf: [
  { required: ['observationId', 'token'], properties: { relative: { const: false }, screenCoordinates: { const: false } }, anyOf: [{ required: ['elementId'] }, { required: ['allowRaw', 'x', 'y'], properties: { allowRaw: { const: true } } }] },
  { required: ['screenCoordinates', 'x', 'y'], properties: { screenCoordinates: { const: true }, relative: { const: false } }, not: { required: ['observationId'] } },
  { required: ['relative'], properties: { relative: { const: true }, screenCoordinates: { const: false } }, not: { required: ['observationId'] }, anyOf: [{ required: ['x'] }, { required: ['y'] }] }
] });

export const dragReleaseSchema = z.object({
  ...lease,
  dragId: z.string().min(1),
  observeAfter: z.boolean().default(true),
  inlineImage: z.boolean().optional().describe('Include the post-action screenshot. By default, compact local elements replace images when semantic controls are available.')
});

export const accessibilitySchema = z.object({
  ...lease,
  observationId: z.string().min(1).optional().describe('Target using observationId, token and elementId; alternatively provide windowHandle and runtimeId.'),
  token: z.string().min(1).optional().describe('Required with observationId. Use the token returned by that observation.'),
  elementId: z.string().min(1).optional().describe('An element from observationId. Required unless runtimeId is supplied.'),
  windowHandle: z.string().min(1).optional().describe('Required with runtimeId when observationId is not supplied.'),
  runtimeId: z.string().min(1).optional().describe('Required unless observationId, token and elementId identify a UI Automation element.'),
  action: z.enum(['focus', 'invoke', 'click', 'setValue', 'toggle', 'select', 'expand', 'collapse', 'scroll', 'scrollIntoView']),
  value: z.string().optional().describe('Required for setValue. For scroll, required direction: up, down, left or right. scroll moves a ScrollPattern container one increment; scrollIntoView reveals a ScrollItemPattern item.'),
  observeAfter: z.boolean().default(true),
  inlineImage: z.boolean().optional().describe('Include the post-action screenshot. By default, compact local elements replace images when semantic controls are available.')
}).superRefine((input, context) => {
  if (input.action === 'scroll' && !['up', 'down', 'left', 'right'].includes(input.value || '')) context.addIssue({ code: 'custom', path: ['value'], message: 'scroll requires value: up, down, left or right on an element that supports scroll; use scrollIntoView to reveal an item.' });
  if (input.action === 'setValue' && input.value === undefined) context.addIssue({ code: 'custom', path: ['value'], message: 'setValue requires value (which may be empty).' });
  if (input.observationId && !input.token) context.addIssue({ code: 'custom', path: ['token'], message: 'token is required with observationId.' });
  if (!input.observationId && !input.windowHandle) context.addIssue({ code: 'custom', path: ['windowHandle'], message: 'Provide observationId, token and elementId, or windowHandle and runtimeId.' });
  if (!(input.observationId && input.elementId) && !input.runtimeId) context.addIssue({ code: 'custom', path: ['runtimeId'], message: 'runtimeId is required unless observationId and elementId identify the target.' });
}).meta({
  allOf: [
    { anyOf: [
      { required: ['observationId', 'token', 'elementId'] },
      { required: ['observationId', 'token', 'runtimeId'] },
      { required: ['windowHandle', 'runtimeId'] }
    ] },
    { if: { required: ['observationId'] }, then: { required: ['token'] } },
    { if: { properties: { action: { const: 'scroll' } } }, then: { required: ['value'], properties: { value: { enum: ['up', 'down', 'left', 'right'] } } } },
    { if: { properties: { action: { const: 'setValue' } } }, then: { required: ['value'] } }
  ]
});
