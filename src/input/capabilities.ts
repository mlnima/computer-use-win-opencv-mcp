import { createRequire } from 'node:module';
import type { RuntimeState } from '../types/runtime';
import { probeNative } from './nativeActions';
import { enqueueInput } from './queue';

const require = createRequire(import.meta.url);

const interceptionInstalled = () => {
  try {
    require.resolve('node-interception');
    return true;
  } catch {
    return false;
  }
};

export const getInputCapabilities = (state: RuntimeState, signal?: AbortSignal) => enqueueInput(state, async (execution) => {
  const probe = await probeNative(state, execution);
  return {
    platform: 'windows',
    backend: 'send-input',
    dpiAware: true,
    physicalCursorReadback: true,
    absolutePointer: true,
    relativePointer: true,
    smoothPointer: true,
    mouseButtons: ['left', 'right', 'middle', 'x1', 'x2'],
    verticalWheel: true,
    horizontalWheel: true,
    unicodeText: true,
    virtualKeys: true,
    scanCodes: true,
    timedTimeline: true,
    interceptionInstalled: interceptionInstalled(),
    interceptionActive: false,
    virtualScreen: probe.screen,
    cursor: { x: probe.x, y: probe.y },
    windowAtCursor: probe.windowHandle
  };
}, { bypassControl: true, deadlineMs: 5_000, signal });
