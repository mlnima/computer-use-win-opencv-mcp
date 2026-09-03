import sharp from 'sharp';
import type { ElementSource, ScreenElement } from '../types/perception';

const sourceColors: Record<ElementSource, string> = {
  uia: '#35d07f',
  ocr: '#42a5f5',
  opencv: '#ffb74d',
  vision: '#ab70ff'
};

const xml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&apos;',
  '"': '&quot;'
})[character] || character);

const marker = (element: ScreenElement, width: number, height: number) => {
  const left = Math.max(0, Math.min(width - 1, element.bounds.left));
  const top = Math.max(0, Math.min(height - 1, element.bounds.top));
  const right = Math.max(left + 1, Math.min(width, element.bounds.right));
  const bottom = Math.max(top + 1, Math.min(height, element.bounds.bottom));
  const color = sourceColors[element.sources[0] || 'opencv'];
  const fontSize = Math.max(11, Math.min(18, Math.round(Math.min(width, height) / 70)));
  const labelWidth = Math.max(fontSize * 2, element.id.length * fontSize * 0.7 + 8);
  const labelTop = top >= fontSize + 8 ? top - fontSize - 5 : top;
  return `<g><rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" fill="none" stroke="${color}" stroke-width="2"/><rect x="${left}" y="${labelTop}" width="${labelWidth}" height="${fontSize + 5}" rx="3" fill="${color}"/><text x="${left + 4}" y="${labelTop + fontSize}" font-family="Segoe UI,Arial,sans-serif" font-size="${fontSize}" font-weight="700" fill="#07110c">${xml(element.id)}</text><circle cx="${element.safePoint.x}" cy="${element.safePoint.y}" r="3" fill="${color}" stroke="#ffffff" stroke-width="1"/></g>`;
};

export const renderSetOfMark = async (
  bytes: Buffer,
  elements: ScreenElement[],
  width: number,
  height: number,
  maxMarkers = 160,
  maxBytes?: number
) => {
  const visible = elements.filter((element) => !element.offscreen).slice(0, maxMarkers);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${visible.map((element) => marker(element, width, height)).join('')}</svg>`;
  let output = await sharp(bytes).composite([{ input: Buffer.from(svg), blend: 'over' }]).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  for (let attempt = 0; maxBytes && output.length > maxBytes && attempt < 10; attempt += 1) {
    const metadata = await sharp(output).metadata();
    const scale = Math.min(0.9, Math.sqrt(maxBytes / output.length) * 0.92);
    const resizedWidth = Math.max(1, Math.floor((metadata.width || width) * scale));
    const resizedHeight = Math.max(1, Math.floor((metadata.height || height) * scale));
    output = await sharp(output).resize(resizedWidth, resizedHeight, { fit: 'fill' }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  }
  if (maxBytes && output.length > maxBytes) throw new Error('Set-of-Mark image cannot fit the configured screenshot byte limit.');
  return output;
};
