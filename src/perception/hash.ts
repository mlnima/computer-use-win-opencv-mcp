import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Bounds } from '../types/geometry';

export const hashImage = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const sampleImage = async (bytes: Buffer) =>
  (await sharp(bytes).resize(128, 128, { fit: 'fill' }).greyscale().raw().toBuffer()).subarray(0, 128 * 128);

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
  return await sharp(bytes)
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize(64, 64, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();
};

export const sampleDifferenceRatio = (first: Buffer, second: Buffer) => {
  const length = Math.min(first.length, second.length);
  if (!length || first.length !== second.length) return 1;
  let difference = 0;
  for (let index = 0; index < length; index += 1) difference += Math.abs(first[index]! - second[index]!);
  return difference / (length * 255);
};

export const imageDifferenceRatio = async (previous: Buffer, current: Buffer) => {
  const [first, second] = await Promise.all([sampleImage(previous), sampleImage(current)]);
  const length = Math.min(first.length, second.length);
  let difference = 0;
  for (let index = 0; index < length; index += 1) difference += Math.abs(first[index]! - second[index]!);
  return length > 0 ? difference / (length * 255) : 1;
};
