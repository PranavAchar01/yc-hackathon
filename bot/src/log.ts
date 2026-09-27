/** Minimal leveled logger. Everything goes to stderr/stdout with an [ots] prefix. */
const stamp = () => new Date().toISOString().slice(11, 19);

export const log = {
  info: (...args: unknown[]) => console.info(`[ots ${stamp()}]`, ...args),
  warn: (...args: unknown[]) => console.warn(`[ots ${stamp()}]`, ...args),
  error: (...args: unknown[]) => console.error(`[ots ${stamp()}]`, ...args),
};
