export const ocrWorkerSource = `
const readline = require('node:readline');
const tesseract = require(process.env.COMPUTER_USE_TESSERACT_MODULE);
let worker;
let languages = '';
let queue = Promise.resolve();
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const getWorker = async (requested) => {
  if (worker && languages === requested) return worker;
  if (worker) await worker.terminate().catch(() => undefined);
  worker = undefined;
  languages = '';
  worker = await tesseract.createWorker(requested.split('+').filter(Boolean), 1, {
    cachePath: process.env.COMPUTER_USE_TESSERACT_CACHE,
    langPath: process.env.COMPUTER_USE_TESSERACT_LANG_PATH || undefined
  });
  languages = requested;
  return worker;
};
const run = async (message) => {
  if (message.op === 'close') {
    if (worker) await worker.terminate().catch(() => undefined);
    send({ id: message.id, ok: true });
    process.exit(0);
  }
  const active = await getWorker(message.languages);
  const result = await active.recognize(Buffer.from(message.image, 'base64'), {}, { blocks: true });
  send({ id: message.id, ok: true, blocks: result.data.blocks || [] });
};
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  queue = queue.catch(() => undefined).then(async () => {
    let message;
    try {
      message = JSON.parse(line);
      await run(message);
    } catch (error) {
      send({ id: message?.id || '', ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
});
process.on('SIGTERM', async () => {
  if (worker) await worker.terminate().catch(() => undefined);
  process.exit(0);
});`;
