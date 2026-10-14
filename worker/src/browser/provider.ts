import type { Page } from "playwright-core";

export interface ViewportSpec {
  name: "desktop" | "mobile";
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  /** Undefined keeps the browser's own user agent. */
  userAgent?: string;
}

export const VIEWPORTS: ViewportSpec[] = [
  { name: "desktop", width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  {
    name: "mobile",
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
];

export interface ViewportPage {
  page: Page;
  userAgent: string;
  close(): Promise<void>;
}

export interface BrowserSession {
  openPage(viewport: ViewportSpec): Promise<ViewportPage>;
  /** Closes the remote browser and returns how long the session was open. */
  close(): Promise<number>;
}

export interface BrowserProvider {
  readonly name: string;
  openSession(): Promise<BrowserSession>;
}
