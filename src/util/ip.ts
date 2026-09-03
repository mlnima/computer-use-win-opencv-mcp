import { isIP } from 'node:net';
import { URL } from 'node:url';

export const normalizeIp = (value: string): string | undefined => {
  const unwrapped = value.trim().replace(/^\[|\]$/g, '').split('%')[0] || '';
  const mapped = /^::ffff:(\d+(?:\.\d+){3})$/i.exec(unwrapped)?.[1];
  const address = mapped && isIP(mapped) === 4 ? mapped : unwrapped;
  if (isIP(address) === 4) return address.split('.').map((part) => Number(part)).join('.');
  if (isIP(address) !== 6) return undefined;
  const hostname = new URL(`http://[${address}]/`).hostname;
  return hostname.replace(/^\[|\]$/g, '').toLocaleLowerCase();
};
