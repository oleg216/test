import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createLogger } from '../shared/logger.js';
import type { DeviceProfile, NetworkProfile } from '../shared/types.js';

const logger = createLogger('browser-pool');

export class BrowserPool {
  private browser: Browser | null = null;
  private contexts = new Map<string, BrowserContext>();

  async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    logger.info('Browser launched');
  }

  async createContext(
    sessionId: string,
    device: DeviceProfile,
    networkEmulation?: NetworkProfile,
  ): Promise<{ context: BrowserContext; page: Page }> {
    if (!this.browser) throw new Error('Browser not initialized');

    const context = await this.browser.newContext({
      userAgent: device.userAgent,
      viewport: { width: device.screenWidth, height: device.screenHeight },
      locale: 'en-US',
      timezoneId: device.timezone,
      geolocation: device.geo ? { latitude: device.geo.lat, longitude: device.geo.lon } : undefined,
      permissions: device.geo ? ['geolocation'] : [],
    });

    if (networkEmulation) {
      const cdpSession = await context.newCDPSession(await context.newPage());
      await cdpSession.send('Network.emulateNetworkConditions', {
        offline: false,
        downloadThroughput: networkEmulation.downloadThroughput,
        uploadThroughput: networkEmulation.uploadThroughput,
        latency: networkEmulation.latency,
      });
      const pages = context.pages();
      const page = pages[pages.length - 1];
      this.contexts.set(sessionId, context);
      return { context, page };
    }

    const page = await context.newPage();
    this.contexts.set(sessionId, context);
    return { context, page };
  }

  async closeContext(sessionId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (context) {
      await context.close();
      this.contexts.delete(sessionId);
    }
  }

  async destroy(): Promise<void> {
    for (const [id, context] of this.contexts) {
      await context.close();
    }
    this.contexts.clear();
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    logger.info('Browser pool destroyed');
  }

  get activeContexts(): number {
    return this.contexts.size;
  }
}
