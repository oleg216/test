import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
import { createLogger } from '../shared/logger.js';
import type { DeviceProfile, NetworkProfile } from '../shared/types.js';
import { buildFingerprintScript } from '../emulation/fingerprint-spoof.js';

const logger = createLogger('browser-pool');

export class BrowserPool {
  private browser: Browser | null = null;
  private contexts = new Map<string, BrowserContext>();
  private cdpSessions = new Map<string, CDPSession>();

  async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-blink-features=AutomationControlled',
      ],
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
      geolocation: device.geo?.lat != null && device.geo?.lon != null
        ? { latitude: device.geo.lat, longitude: device.geo.lon }
        : undefined,
      permissions: device.geo?.lat != null ? ['geolocation'] : [],
    });

    // Inject fingerprint spoof before any page loads
    if (device.fingerprint) {
      await context.addInitScript(buildFingerprintScript(device.fingerprint));
    }

    if (networkEmulation) {
      const page = await context.newPage();
      const cdpSession = await context.newCDPSession(page);
      await cdpSession.send('Network.emulateNetworkConditions', {
        offline: false,
        downloadThroughput: networkEmulation.downloadThroughput,
        uploadThroughput: networkEmulation.uploadThroughput,
        latency: networkEmulation.latency,
      });
      this.cdpSessions.set(sessionId, cdpSession);
      this.contexts.set(sessionId, context);
      return { context, page };
    }

    const page = await context.newPage();
    this.contexts.set(sessionId, context);
    return { context, page };
  }

  async closeContext(sessionId: string): Promise<void> {
    const cdp = this.cdpSessions.get(sessionId);
    if (cdp) {
      await cdp.detach().catch(() => {});
      this.cdpSessions.delete(sessionId);
    }
    const context = this.contexts.get(sessionId);
    if (context) {
      await context.close();
      this.contexts.delete(sessionId);
    }
  }

  async destroy(): Promise<void> {
    for (const cdp of this.cdpSessions.values()) {
      await cdp.detach().catch(() => {});
    }
    this.cdpSessions.clear();
    for (const context of this.contexts.values()) {
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
