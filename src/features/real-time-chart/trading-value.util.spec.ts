import { normalizeTradingValueToWon } from './trading-value.util';

describe('normalizeTradingValueToWon', () => {
  it('scales million-KRW values to KRW', () => {
    expect(normalizeTradingValueToWon(5_684)).toBe(5_684_000_000n);
    expect(normalizeTradingValueToWon('1,382')).toBe(1_382_000_000n);
    expect(normalizeTradingValueToWon(141n)).toBe(141_000_000n);
  });

  it('keeps values already in KRW', () => {
    expect(normalizeTradingValueToWon(65_895_000_000n)).toBe(65_895_000_000n);
    expect(normalizeTradingValueToWon(10_000_000)).toBe(10_000_000n);
  });

  it('returns zero for empty or invalid values', () => {
    expect(normalizeTradingValueToWon(null)).toBe(0n);
    expect(normalizeTradingValueToWon(undefined)).toBe(0n);
    expect(normalizeTradingValueToWon(-5)).toBe(0n);
    expect(normalizeTradingValueToWon('abc')).toBe(0n);
  });
});
