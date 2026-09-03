import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Bounds } from '../types/geometry';

export const hashImage = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const featureSample = async (bytes: Buffer, size: number) => {
  const count = size * size;
  const pixels = (await sharp(bytes).resize(size, size, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer()).subarray(0, count * 3);
  if (pixels.length !== count * 3) throw new Error('Image color sampling failed.');
  const luminance = Buffer.allocUnsafe(count);
  const edges = Buffer.alloc(count);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    luminance[index] = Math.round(pixels[offset]! * 0.2126 + pixels[offset + 1]! * 0.7152 + pixels[offset + 2]! * 0.0722);
  }
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x;
      const horizontal = x + 1 < size ? Math.abs(luminance[index]! - luminance[index + 1]!) : 0;
      const vertical = y + 1 < size ? Math.abs(luminance[index]! - luminance[index + size]!) : 0;
      edges[index] = Math.min(255, horizontal + vertical);
    }
  }
  return Buffer.concat([pixels, edges]);
};

export const sampleScreenRegion = async (bytes: Buffer, imageBounds: Bounds, region: Bounds) => {
  const metadata = await sharp(bytes).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const screenWidth = imageBounds.right - imageBounds.left;
  const screenHeight = imageBounds.bottom - imageBounds.top;
  if (!width || !height || screenWidth <= 0 || screenHeight <= 0) throw new Error('Image geometry is unavailable for local verification.');
  const left = Math.max(0, Math.floor((region.left - imageBounds.left) * width / screenWidth));
  const top = Math.max(0, Math.floor((region.top - imageBounds.top) * height / screenHeight));
  const right = Math.min(width, Math.ceil((region.right - imageBounds.left) * width / screenWidth));
  const bottom = Math.min(height, Math.ceil((region.bottom - imageBounds.top) * height / screenHeight));
  if (right <= left || bottom <= top) throw new Error('Verification region is outside the current capture.');
  const crop = await sharp(bytes)
    .extract({ left, top, width: right - left, height: bottom - top })
    .toBuffer();
  return await featureSample(crop, 64);
};

export const sampleDifferenceRatio = (first: Buffer, second: Buffer) => {
  if (!first.length || first.length !== second.length || first.length % 4 !== 0) return 1;
  const pixelCount = first.length / 4;
  let colorDifference = 0;
  let edgeDifference = 0;
  for (let index = 0; index < pixelCount * 3; index += 1) colorDifference += Math.abs(first[index]! - second[index]!);
  for (let index = pixelCount * 3; index < first.length; index += 1) edgeDifference += Math.abs(first[index]! - second[index]!);
  return colorDifference / (pixelCount * 3 * 255) * 0.7 + edgeDifference / (pixelCount * 255) * 0.3;
};

export const imageDifferenceRatio = async (previous: Buffer, current: Buffer) => {
  const [first, second] = await Promise.all([featureSample(previous, 128), featureSample(current, 128)]);
  return sampleDifferenceRatio(first, second);
};
