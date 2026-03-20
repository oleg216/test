import { ProxyAgent } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';
import https from 'node:https';
import http from 'node:http';

const httpAgentCache = new Map<string, ProxyAgent>();
const socksAgentCache = new Map<string, SocksProxyAgent>();

function isSocks(url: string): boolean {
  return url.startsWith('socks');
}

export function getProxyAgent(proxyUrl: string): ProxyAgent {
  let agent = httpAgentCache.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    httpAgentCache.set(proxyUrl, agent);
  }
  return agent;
}

export function getSocksAgent(proxyUrl: string): SocksProxyAgent {
  let agent = socksAgentCache.get(proxyUrl);
  if (!agent) {
    agent = new SocksProxyAgent(proxyUrl);
    socksAgentCache.set(proxyUrl, agent);
  }
  return agent;
}

/**
 * Fetch a URL through a SOCKS proxy using node:http/https.
 */
function socksFetch(url: string, agent: SocksProxyAgent, options: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; timeout?: number }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const timeoutMs = options.timeout || 10000;
    const req = mod.request(url, {
      method: options.method || 'GET',
      agent,
      headers: options.headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(hardTimeout);
        const status = res.statusCode || 200;
        // HTTP 204/304 are null-body statuses — Response constructor rejects body for them
        const isNullBody = status === 204 || status === 304;
        const body = Buffer.concat(chunks).toString();
        resolve(new Response(isNullBody ? null : body, {
          status,
          statusText: res.statusMessage || '',
          headers: res.headers as Record<string, string>,
        }));
      });
    });
    const hardTimeout = setTimeout(() => {
      req.destroy();
      reject(new Error('SOCKS request timeout'));
    }, timeoutMs);
    req.on('timeout', () => { req.destroy(); reject(new Error('SOCKS socket timeout')); });
    req.on('error', (err) => { clearTimeout(hardTimeout); reject(err); });
    if (options.signal) {
      if (options.signal.aborted) { req.destroy(new Error('Aborted')); return; }
      options.signal.addEventListener('abort', () => { req.destroy(new Error('Aborted')); }, { once: true });
    }
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Create a fetch function that routes requests through a proxy.
 * Supports both HTTP and SOCKS5 proxies.
 * If no proxyUrl is provided, returns undefined (use default fetch).
 */
export function createProxyFetch(proxyUrl?: string) {
  if (!proxyUrl) return undefined;

  if (isSocks(proxyUrl)) {
    const agent = getSocksAgent(proxyUrl);
    return async (url: string, init?: RequestInit): Promise<Response> => {
      return socksFetch(url, agent, {
        method: init?.method,
        headers: init?.headers as Record<string, string>,
        body: init?.body as string,
        signal: init?.signal ?? undefined,
      });
    };
  }

  const agent = getProxyAgent(proxyUrl);
  return async (url: string, init?: RequestInit): Promise<Response> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return fetch(url, { ...init, dispatcher: agent } as any);
  };
}
