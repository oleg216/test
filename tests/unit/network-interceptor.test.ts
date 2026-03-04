import { describe, it, expect } from 'vitest';
import { classifyRequest } from '../../src/worker/network-interceptor.js';

describe('classifyRequest', () => {
  it('classifies RTB requests', () => {
    expect(classifyRequest('https://ssp.example.com/bid', 'POST')).toBe('rtb');
  });

  it('classifies VAST requests', () => {
    expect(classifyRequest('https://ad.example.com/vast.xml', 'GET')).toBe('vast');
  });

  it('classifies media requests', () => {
    expect(classifyRequest('https://cdn.example.com/ad.mp4', 'GET')).toBe('media');
    expect(classifyRequest('https://cdn.example.com/stream.m3u8', 'GET')).toBe('media');
  });

  it('classifies tracking requests', () => {
    expect(classifyRequest('https://tracker.example.com/impression?cb=123', 'GET')).toBe('tracking');
  });

  it('defaults to content', () => {
    expect(classifyRequest('https://cdn.example.com/page.html', 'GET')).toBe('content');
  });
});
