import type { ScreenElement } from '../types/perception';
import { boundsArea, clipBounds, safePointForBounds } from './geometry';

export type OcrBox = { x0: number; y0: number; x1: number; y1: number };
export type OcrWord = { text?: string; confidence?: number; bbox?: OcrBox };
export type OcrLine = { text?: string; confidence?: number; bbox?: OcrBox; words?: OcrWord[] };
export type OcrParagraph = { lines?: OcrLine[] };
export type OcrBlock = { paragraphs?: OcrParagraph[] };

const elementFromText = (
  text: string,
  confidence: number,
  box: OcrBox,
  width: number,
  height: number,
  id: string,
  role: string
): ScreenElement | undefined => {
  const bounds = clipBounds({ left: box.x0, top: box.y0, right: box.x1, bottom: box.y1 }, width, height);
  const safePoint = safePointForBounds(bounds);
  return text && confidence >= 20 && boundsArea(bounds) >= 4 && safePoint ? {
    id,
    role,
    name: text,
    bounds,
    safePoint,
    confidence: Math.max(0.25, Math.min(0.94, confidence / 100)),
    enabled: true,
    focused: false,
    offscreen: false,
    actions: ['click'],
    sources: ['ocr']
  } : undefined;
};

export const extractOcrElements = (blocks: OcrBlock[], width: number, height: number, maxElements: number) => {
  const elements: ScreenElement[] = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const words = (line.words || []).filter((word) => word.text?.trim() && word.bbox);
        const lineText = line.text?.replace(/\s+/g, ' ').trim() || words.map((word) => word.text?.trim()).join(' ');
        if (words.length > 1 && line.bbox && elements.length < maxElements) {
          const element = elementFromText(lineText, line.confidence || 0, line.bbox, width, height, `ocr:line:${elements.length}`, 'textLine');
          if (element) elements.push(element);
        }
        for (const word of words) {
          if (elements.length >= maxElements) return elements;
          const element = elementFromText(word.text?.trim() || '', word.confidence || 0, word.bbox!, width, height, `ocr:word:${elements.length}`, 'text');
          if (element) elements.push(element);
        }
      }
    }
  }
  return elements;
};
