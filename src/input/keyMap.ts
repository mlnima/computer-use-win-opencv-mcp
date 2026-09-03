export type KeyMethod = 'virtual-key' | 'scan-code';

export type ResolvedKey = {
  id: string;
  virtualKey?: number;
  scanCode?: number;
  extended: boolean;
};

const keyCodes: Record<string, number> = {
  backspace: 0x08,
  tab: 0x09,
  clear: 0x0c,
  enter: 0x0d,
  shift: 0x10,
  control: 0x11,
  alt: 0x12,
  pause: 0x13,
  capslock: 0x14,
  escape: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  select: 0x29,
  print: 0x2a,
  execute: 0x2b,
  printscreen: 0x2c,
  insert: 0x2d,
  delete: 0x2e,
  help: 0x2f,
  meta: 0x5b,
  leftmeta: 0x5b,
  rightmeta: 0x5c,
  applications: 0x5d,
  sleep: 0x5f,
  numpad0: 0x60,
  numpad1: 0x61,
  numpad2: 0x62,
  numpad3: 0x63,
  numpad4: 0x64,
  numpad5: 0x65,
  numpad6: 0x66,
  numpad7: 0x67,
  numpad8: 0x68,
  numpad9: 0x69,
  multiply: 0x6a,
  add: 0x6b,
  separator: 0x6c,
  subtract: 0x6d,
  decimal: 0x6e,
  divide: 0x6f,
  numlock: 0x90,
  scrolllock: 0x91,
  leftshift: 0xa0,
  rightshift: 0xa1,
  leftcontrol: 0xa2,
  rightcontrol: 0xa3,
  leftalt: 0xa4,
  rightalt: 0xa5,
  browserback: 0xa6,
  browserforward: 0xa7,
  browserrefresh: 0xa8,
  browserstop: 0xa9,
  browsersearch: 0xaa,
  browserfavorites: 0xab,
  browserhome: 0xac,
  volumemute: 0xad,
  volumedown: 0xae,
  volumeup: 0xaf,
  medianext: 0xb0,
  mediaprevious: 0xb1,
  mediastop: 0xb2,
  mediaplaypause: 0xb3,
  launchmail: 0xb4,
  launchmedia: 0xb5,
  launchapp1: 0xb6,
  launchapp2: 0xb7,
  semicolon: 0xba,
  equals: 0xbb,
  comma: 0xbc,
  minus: 0xbd,
  period: 0xbe,
  slash: 0xbf,
  backtick: 0xc0,
  leftbracket: 0xdb,
  backslash: 0xdc,
  rightbracket: 0xdd,
  quote: 0xde
};

const aliases: Record<string, string> = {
  return: 'enter',
  esc: 'escape',
  ctrl: 'control',
  ctl: 'control',
  option: 'alt',
  command: 'meta',
  cmd: 'meta',
  win: 'meta',
  windows: 'meta',
  super: 'meta',
  menu: 'applications',
  pgup: 'pageup',
  pgdn: 'pagedown',
  del: 'delete',
  ins: 'insert',
  prtsc: 'printscreen',
  snapshot: 'printscreen',
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  spacebar: 'space',
  contextmenu: 'applications',
  shiftleft: 'leftshift',
  shiftright: 'rightshift',
  controlleft: 'leftcontrol',
  controlright: 'rightcontrol',
  altleft: 'leftalt',
  altright: 'rightalt',
  metaleft: 'leftmeta',
  metaright: 'rightmeta',
  lshift: 'leftshift',
  rshift: 'rightshift',
  lctrl: 'leftcontrol',
  rctrl: 'rightcontrol',
  lalt: 'leftalt',
  ralt: 'rightalt',
  lwin: 'leftmeta',
  rwin: 'rightmeta',
  volumeup: 'volumeup',
  volumedown: 'volumedown',
  mute: 'volumemute'
};

const punctuationCodes: Record<string, number> = {
  ';': 0xba,
  '=': 0xbb,
  ',': 0xbc,
  '-': 0xbd,
  '.': 0xbe,
  '/': 0xbf,
  '`': 0xc0,
  '[': 0xdb,
  '\\': 0xdc,
  ']': 0xdd,
  "'": 0xde
};

const extendedCodes = new Set([
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2c, 0x2d, 0x2e,
  0x5b, 0x5c, 0x5d, 0x6f, 0x90, 0xa3, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac,
  0xad, 0xae, 0xaf, 0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7
]);

const parseNumber = (value: string) => {
  const parsed = value.toLowerCase().startsWith('0x')
    ? Number.parseInt(value.slice(2), 16)
    : Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffff ? parsed : undefined;
};

const normalizedName = (key: string) => key.trim().toLowerCase().replace(/[\s_-]/g, '');

export const resolveKey = (key: string): ResolvedKey => {
  const value = key.trim();
  const lower = value.toLowerCase();
  if (lower.startsWith('vk:')) {
    const virtualKey = parseNumber(value.slice(3));
    if (virtualKey === undefined) throw new Error(`Invalid virtual key: ${key}`);
    return { id: `vk:${virtualKey}`, virtualKey, extended: extendedCodes.has(virtualKey) };
  }
  if (lower.startsWith('scan:')) {
    const rawScan = parseNumber(value.slice(5));
    if (rawScan === undefined) throw new Error(`Invalid scan code: ${key}`);
    const extended = rawScan > 0xff;
    const scanCode = extended ? rawScan & 0xff : rawScan;
    return { id: `scan:${rawScan}`, scanCode, extended };
  }
  if (/^[a-z]$/i.test(value)) {
    const virtualKey = value.toUpperCase().charCodeAt(0);
    return { id: `vk:${virtualKey}`, virtualKey, extended: false };
  }
  if (/^[0-9]$/.test(value)) {
    const virtualKey = value.charCodeAt(0);
    return { id: `vk:${virtualKey}`, virtualKey, extended: false };
  }
  const functionMatch = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(value);
  if (functionMatch) {
    const virtualKey = 0x6f + Number(functionMatch[1]);
    return { id: `vk:${virtualKey}`, virtualKey, extended: false };
  }
  const punctuation = punctuationCodes[value];
  if (punctuation) return { id: `vk:${punctuation}`, virtualKey: punctuation, extended: false };
  const normalized = normalizedName(value);
  const canonical = aliases[normalized] || normalized;
  const virtualKey = keyCodes[canonical];
  if (virtualKey === undefined) throw new Error(`Unsupported key: ${key}`);
  return { id: `vk:${virtualKey}`, virtualKey, extended: extendedCodes.has(virtualKey) };
};
