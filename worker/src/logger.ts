import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, event: string, data?: Record<string, unknown>): void;
}

export function createLogger(filePath: string): Logger {
  mkdirSync(dirname(filePath), { recursive: true });
  return {
    log(level, event, data = {}) {
      const entry = { ts: new Date().toISOString(), level, event, ...data };
      appendFileSync(filePath, JSON.stringify(entry) + "\n");
      const detail = Object.entries(data)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      const line = `[${entry.ts}] ${level.toUpperCase().padEnd(5)} ${event} ${detail}`;
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    },
  };
}
