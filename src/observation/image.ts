import sharp from 'sharp';
import type { ServerConfig } from '../config';

export type PreparedImage = {
  bytes: Buffer;
  width: number;
  height: number;
  mimeType: 'image/png' | 'image/jpeg';
  warnings: string[];
};

const constrainedSize = (width: number, height: number, maximum: number) => {
  const scale = Math.min(1, maximum / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

export const prepareObservationImage = async (
  bytes: Buffer,
  width: number,
  height: number,
  config: ServerConfig
): Promise<PreparedImage> => {
  const requested = constrainedSize(width, height, config.screenshotMaxSide);
  let output = await sharp(bytes).resize(requested.width, requested.height, { fit: 'fill' }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  let mimeType: PreparedImage['mimeType'] = 'image/png';
  const warnings: string[] = [];
  if (output.length > config.screenshotMaxBytes) {
    const byteScale = Math.min(1, Math.sqrt(config.screenshotMaxBytes / output.length));
    let reduced = constrainedSize(Math.round(requested.width * byteScale), Math.round(requested.height * byteScale), config.screenshotMaxSide);
    let quality = 82;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      output = await sharp(bytes).resize(reduced.width, reduced.height, { fit: 'fill' }).jpeg({ quality, mozjpeg: true }).toBuffer();
      if (output.length <= config.screenshotMaxBytes) break;
      if (quality > 42) quality -= 10;
      else reduced = constrainedSize(Math.floor(reduced.width * 0.72), Math.floor(reduced.height * 0.72), config.screenshotMaxSide);
    }
    if (output.length > config.screenshotMaxBytes) throw new Error('Screenshot cannot fit the configured byte limit. Increase COMPUTER_USE_SCREENSHOT_MAX_BYTES.');
    mimeType = 'image/jpeg';
    warnings.push('Screenshot was reduced and encoded as JPEG to respect the configured byte limit.');
  }
  const metadata = await sharp(output).metadata();
  return {
    bytes: output,
    width: metadata.width || requested.width,
    height: metadata.height || requested.height,
    mimeType,
    warnings
  };
};
