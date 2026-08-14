// ─── utils/logger.ts — Production Structured Logger with requestId ─────────────
//
// Fix OBS-H-01: Every log line now carries the requestId from AsyncLocalStorage
// so a single request's full lifecycle (auth → credit → OpenRouter → telemetry)
// can be found with one log query:  requestId: "abc-123"

import { AsyncLocalStorage } from 'async_hooks';

// Shared store — set once per request in index.ts middleware
export const requestIdStore = new AsyncLocalStorage<string>();

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO  = 'INFO',
  WARN  = 'WARN',
  ERROR = 'ERROR',
}

class Logger {
  private formatLog(level: LogLevel, message: string, meta?: unknown): string {
    const timestamp  = new Date().toISOString();
    const requestId  = requestIdStore.getStore() ?? '-';
    const metaString = meta ? ` | ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level}] [req:${requestId}] ${message}${metaString}`;
  }

  debug(message: string, meta?: unknown): void {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(this.formatLog(LogLevel.DEBUG, message, meta));
    }
  }

  info(message: string, meta?: unknown): void {
    console.log(this.formatLog(LogLevel.INFO, message, meta));
  }

  warn(message: string, meta?: unknown): void {
    console.warn(this.formatLog(LogLevel.WARN, message, meta));
  }

  error(message: string, error?: unknown): void {
    const errorDetails = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : error;
    console.error(this.formatLog(LogLevel.ERROR, message, errorDetails));
  }
}

export const logger = new Logger();
