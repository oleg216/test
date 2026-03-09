import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseVastXml, parseDuration } from '../../src/engines/vast-resolver.js';

const readFixture = (name: string) =>
  readFileSync(resolve(process.cwd(), 'fixtures', name), 'utf-8');

describe('parseDuration', () => {
  it('parses HH:MM:SS format', () => {
    expect(parseDuration('00:00:20')).toBe(20);
    expect(parseDuration('00:01:30')).toBe(90);
    expect(parseDuration('01:00:00')).toBe(3600);
  });
});

describe('parseVastXml', () => {
  it('parses inline VAST with MP4 media', () => {
    const xml = readFixture('inline-mp4.xml');
    const result = parseVastXml(xml);
    expect(result.type).toBe('inline');
    expect(result.mediaUrl).toContain('ad.mp4');
    expect(result.duration).toBe(20);
    expect(result.impressionUrls).toContain('https://tracker.example.com/impression');
    expect(result.trackingEvents.get('start')).toContain('https://tracker.example.com/start');
    expect(result.trackingEvents.get('complete')).toContain('https://tracker.example.com/complete');
  });

  it('parses wrapper VAST and returns tag URI', () => {
    const xml = readFixture('wrapper-simple.xml');
    const result = parseVastXml(xml);
    expect(result.type).toBe('wrapper');
    expect(result.vastTagUri).toBeTruthy();
    expect(result.impressionUrls).toContain('https://wrapper-tracker.example.com/impression');
  });

  it('parses HLS ad', () => {
    const xml = readFixture('hls-ad.xml');
    const result = parseVastXml(xml);
    expect(result.type).toBe('inline');
    expect(result.mediaUrl).toContain('.m3u8');
    expect(result.duration).toBe(15);
  });

  it('extracts ClickThrough and ClickTracking URLs', () => {
    const xml = readFixture('inline-mp4-with-clicks.xml');
    const result = parseVastXml(xml);
    expect(result.type).toBe('inline');
    expect(result.clickThroughUrl).toBe('https://advertiser.example.com/landing-page');
    expect(result.clickTrackingUrls).toHaveLength(2);
    expect(result.clickTrackingUrls).toContain('https://tracker.example.com/click');
    expect(result.clickTrackingUrls).toContain('https://tracker2.example.com/click');
  });

  it('returns empty click arrays when no click elements', () => {
    const xml = readFixture('inline-mp4.xml');
    const result = parseVastXml(xml);
    expect(result.clickThroughUrl).toBeUndefined();
    expect(result.clickTrackingUrls).toHaveLength(0);
  });
});
