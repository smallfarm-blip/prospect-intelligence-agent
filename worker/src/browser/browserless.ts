import { chromium } from "playwright-core";
import type { BrowserProvider, BrowserSession, ViewportSpec } from "./provider.ts";

export class BrowserlessProvider implements BrowserProvider {
  readonly name = "browserless";

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly sessionTimeoutMs: number,
  ) {}

  async openSession(): Promise<BrowserSession> {
    const url = new URL(this.endpoint);
    url.searchParams.set("token", this.token);
    url.searchParams.set("timeout", String(this.sessionTimeoutMs));

    const startedAt = Date.now();
    const browser = await chromium.connectOverCDP(url.toString(), { timeout: 30_000 });
    let closed = false;

    return {
      async openPage(viewport: ViewportSpec) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.deviceScaleFactor,
          isMobile: viewport.isMobile,
          hasTouch: viewport.hasTouch,
          ...(viewport.userAgent ? { userAgent: viewport.userAgent } : {}),
        });
        const page = await context.newPage();
        const userAgent = await page.evaluate(() => navigator.userAgent);
        return { page, userAgent, close: () => context.close().catch(() => undefined) };
      },
      async close() {
        if (!closed) {
          closed = true;
          await browser.close().catch(() => undefined);
        }
        return Date.now() - startedAt;
      },
    };
  }
}
