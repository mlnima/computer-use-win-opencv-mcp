import process from 'node:process';

const privateVariables = new Set([
  'COMPUTER_USE_AUTH_TOKEN',
  'COMPUTER_USE_VISION_API_KEY'
]);

export const childEnvironment = (values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => Object.fromEntries(
  Object.entries({ ...process.env, ...values }).filter(([name, value]) =>
    typeof value === 'string' && !privateVariables.has(name.toUpperCase()))
);
