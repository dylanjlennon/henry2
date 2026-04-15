/**
 * Structured logger — JSON-per-line, correlation-id aware.
 *
 *   log.info('run_started', { pin: '...' })
 *
 * Use `log.child({ runId, fetcherCallId, ... })` to get a logger that
 * automatically tags every line with the given correlation fields. Loggers
 * are cheap to create and can be nested: each `.child()` call merges over
 * the parent's fields.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'];

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(ctx: Record<string, unknown>): Logger;
}

function make(base: Record<string, unknown>): Logger {
  const emit = (level: Level, msg: string, meta?: Record<string, unknown>): void => {
    if (LEVELS[level] < MIN) return;
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      msg,
      ...base,
      ...meta,
    });
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  };
  return {
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
    child: (ctx) => make({ ...base, ...ctx }),
  };
}

export const log: Logger = make({});
