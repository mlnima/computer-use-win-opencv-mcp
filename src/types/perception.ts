import type { Bounds, Point, WindowInfo } from './geometry';

export type ElementSource = 'uia' | 'ocr' | 'opencv' | 'vision';

export type ElementAction = 'click' | 'doubleClick' | 'rightClick' | 'focus' | 'invoke' | 'setValue' | 'toggle' | 'select' | 'expand' | 'collapse' | 'scroll' | 'drag';

export type ScreenElement = {
  id: string;
  role: string;
  name: string;
  value?: string;
  bounds: Bounds;
  safePoint: Point;
  confidence: number;
  enabled: boolean;
  focused: boolean;
  offscreen: boolean;
  actions: ElementAction[];
  sources: ElementSource[];
  evidence?: string[];
  uiaRuntimeId?: string;
  uiaClickablePoint?: boolean;
  uiaRole?: string;
  uiaName?: string;
  uiaValue?: string;
  parentId?: string;
  children?: string[];
};

export type ScreenshotRecord = {
  id: string;
  observationId: string;
  mimeType: 'image/png' | 'image/jpeg';
  bytes: Buffer;
  width: number;
  height: number;
  bounds: Bounds;
  windowHandle?: string;
  hash: string;
  capturedAt: string;
};

export type Observation = {
  id: string;
  token: string;
  capturedAt: string;
  expiresAt: string;
  target: 'desktop' | 'window' | 'region';
  window?: WindowInfo;
  screenshotId: string;
  sceneUri?: string;
  width: number;
  height: number;
  bounds: Bounds;
  cursor: Point;
  elements: ScreenElement[];
  sourceCounts: Partial<Record<ElementSource, number>>;
  imageChanged?: boolean;
  warnings: string[];
};

export type LocateResult = {
  observationId: string;
  query: string;
  matches: Array<ScreenElement & { score: number; reasons: string[] }>;
  usedVision: boolean;
};

export type AccessibilityNode = Omit<ScreenElement, 'id' | 'sources' | 'safePoint' | 'confidence'> & {
  runtimeId: string;
  depth: number;
  clickablePoint?: Point;
  pointerAncestors?: string[];
};
