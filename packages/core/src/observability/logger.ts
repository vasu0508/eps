// Concrete ConsoleLogger implementation for @workflow/core observability

import type { Logger } from "../types.js";

/**
 * A structured logger that writes to the console.
 * Each log message includes a timestamp and an optional prefix.
 */
export class ConsoleLogger implements Logger {
  private readonly prefix: string;

  constructor(prefix?: string) {
    this.prefix = prefix ?? "";
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.emit("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.emit("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.emit("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.emit("error", message, meta);
  }

  private emit(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>
  ): void {
    const timestamp = new Date().toISOString();
    const prefixStr = this.prefix ? `[${this.prefix}] ` : "";
    const metaStr = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
    const formatted = `${timestamp} ${level.toUpperCase()} ${prefixStr}${message}${metaStr}`;

    switch (level) {
      case "debug":
        console.debug(formatted);
        break;
      case "info":
        console.info(formatted);
        break;
      case "warn":
        console.warn(formatted);
        break;
      case "error":
        console.error(formatted);
        break;
    }
  }
}
