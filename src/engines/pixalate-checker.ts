import { createLogger, maskSensitiveData } from '../shared/logger.js';
import { PIXALATE_API_KEY, PIXALATE_BASE_URL, PIXALATE_THRESHOLD } from '../shared/constants.js';

const logger = createLogger('pixalate-checker');

export interface PixalateCheckResult {
  probability: number;
  reason?: string;
  pass: boolean;
  rawResponse?: Record<string, unknown>;
  httpStatus?: number;
}

export interface PixalateSessionParams {
  ip: string;
  ua: string;
  deviceId?: string;
}

export class PixalateChecker {
  private apiKey: string;
  private baseUrl: string;
  private threshold: number;

  constructor(apiKey?: string, baseUrl?: string, threshold?: number) {
    this.apiKey = apiKey || PIXALATE_API_KEY;
    this.baseUrl = baseUrl || PIXALATE_BASE_URL;
    this.threshold = threshold || PIXALATE_THRESHOLD;
  }

  get enabled(): boolean {
    return !!this.apiKey;
  }

  /**
   * Check IP only via Pixalate Fraud API
   * GET /api/v2/fraud?ip=...
   */
  async checkIp(ip: string): Promise<PixalateCheckResult> {
    return this.query({ ip });
  }

  /**
   * Check User-Agent only
   * GET /api/v2/fraud?userAgent=...
   */
  async checkUserAgent(ua: string): Promise<PixalateCheckResult> {
    return this.query({ userAgent: ua });
  }

  /**
   * Combined check: IP + UA + optional deviceId
   * GET /api/v2/fraud?ip=...&userAgent=...&deviceId=...
   */
  async checkSession(params: PixalateSessionParams): Promise<PixalateCheckResult> {
    const q: Record<string, string> = { ip: params.ip, userAgent: params.ua };
    if (params.deviceId) q.deviceId = params.deviceId;
    return this.query(q);
  }

  /**
   * Single query to Pixalate Fraud API
   * Endpoint: GET {baseUrl}/api/v2/fraud?...
   * Header: x-api-key
   * Response: { probability: 0.01..1.0 }
   */
  private async query(params: Record<string, string>): Promise<PixalateCheckResult> {
    if (!this.enabled) return { probability: 0, pass: true, reason: 'no_api_key' };

    const qs = new URLSearchParams(params);
    const url = `${this.baseUrl}/api/v2/fraud?${qs.toString()}`;

    try {
      const response = await fetch(url, {
        headers: {
          'x-api-key': this.apiKey,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn({ params: maskSensitiveData(params), status: response.status, body }, 'Pixalate API error');
        return { probability: 0, pass: true, reason: `API error: ${response.status}`, httpStatus: response.status };
      }

      const data = await response.json() as Record<string, unknown>;
      const probability = typeof data.probability === 'number' ? data.probability : 0;
      const pass = probability <= this.threshold;

      if (!pass) {
        logger.warn({ params: maskSensitiveData(params), probability }, 'Pixalate fraud detected');
      } else {
        logger.info({ params: maskSensitiveData(params), probability }, 'Pixalate check passed');
      }

      return { probability, pass, rawResponse: data, httpStatus: response.status };
    } catch (err) {
      logger.error({ params: maskSensitiveData(params), err }, 'Pixalate request failed');
      return { probability: 0, pass: true, reason: 'network_error' };
    }
  }
}
