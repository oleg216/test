import { ProxyAgent } from 'undici';

const agentCache = new Map<string, ProxyAgent>();

export function getProxyAgent(proxyUrl: string): ProxyAgent {
  let agent = agentCache.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    agentCache.set(proxyUrl, agent);
  }
  return agent;
}

/**
 * Create a fetch function that routes requests through a proxy.
 * If no proxyUrl is provided, returns undefined (use default fetch).
 */
export function createProxyFetch(proxyUrl?: string) {
  if (!proxyUrl) return undefined;

  const agent = getProxyAgent(proxyUrl);

  return async (url: string, init?: RequestInit): Promise<Response> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return fetch(url, { ...init, dispatcher: agent } as any);
  };
}
