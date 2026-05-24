import { describe, expect, it } from 'vitest';
import {
  headerUsageExtractor,
  nullUsageExtractor,
  openAiUsageExtractor,
} from './usage.js';

describe('headerUsageExtractor (default)', () => {
  const extract = headerUsageExtractor();

  it('reads the generic X-Airlock-Units header', () => {
    expect(extract({ agentHeaders: { 'X-Airlock-Units': '42' } })).toEqual({ units: 42 });
  });

  it('falls back to legacy X-Tokens-Used and labels it tokens', () => {
    expect(extract({ agentHeaders: { 'X-Tokens-Used': '17' } })).toEqual({
      units: 17,
      unitLabel: 'tokens',
    });
  });

  it('prefers units over the legacy tokens header', () => {
    expect(
      extract({ agentHeaders: { 'X-Airlock-Units': '5', 'X-Tokens-Used': '99' } }),
    ).toEqual({ units: 5 });
  });

  it('is case-insensitive on header names', () => {
    expect(extract({ agentHeaders: { 'x-tokens-used': '8' } })).toEqual({
      units: 8,
      unitLabel: 'tokens',
    });
  });

  it('returns null for missing, zero, or non-numeric values', () => {
    expect(extract({ agentHeaders: {} })).toBeNull();
    expect(extract({})).toBeNull();
    expect(extract({ agentHeaders: { 'X-Airlock-Units': '0' } })).toBeNull();
    expect(extract({ agentHeaders: { 'X-Airlock-Units': 'abc' } })).toBeNull();
  });

  it('reads an explicit custom header when provided', () => {
    const custom = headerUsageExtractor('X-Steps');
    expect(custom({ agentHeaders: { 'X-Steps': '3' } })).toEqual({ units: 3 });
    // and ignores the default headers in explicit mode
    expect(custom({ agentHeaders: { 'X-Airlock-Units': '9' } })).toBeNull();
  });
});

describe('openAiUsageExtractor', () => {
  const extract = openAiUsageExtractor();

  it('reads usage.total_tokens from the body', () => {
    expect(extract({ agentBody: { usage: { total_tokens: 123 } } })).toEqual({
      units: 123,
      unitLabel: 'tokens',
    });
  });

  it('returns null when usage is absent, zero, or the body is not an object', () => {
    expect(extract({ agentBody: { choices: [] } })).toBeNull();
    expect(extract({ agentBody: { usage: { total_tokens: 0 } } })).toBeNull();
    expect(extract({ agentBody: 'plain text' })).toBeNull();
    expect(extract({})).toBeNull();
  });
});

describe('nullUsageExtractor', () => {
  it('always returns null (flat per-call path)', () => {
    const extract = nullUsageExtractor();
    expect(extract({ agentHeaders: { 'X-Airlock-Units': '5' } })).toBeNull();
    expect(extract({ agentBody: { usage: { total_tokens: 9 } } })).toBeNull();
  });
});
