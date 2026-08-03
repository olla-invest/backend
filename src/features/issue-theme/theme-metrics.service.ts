import { Injectable } from '@nestjs/common';

export type ThemeDirection = 'STRONG' | 'WEAK' | 'NEUTRAL';
export type ThemeBadgeTone = 'RED' | 'ORANGE' | 'BLUE' | null;

export interface ThemeMetricStock {
  stockCode: string;
  rsScore: number;
  changeRate: number;
  isNewHigh: boolean;
}

export interface ThemeMetricHistory {
  tradeDate: string;
  avgRsScore: number;
}

export interface ThemeStreak {
  direction: ThemeDirection;
  days: number;
  label: string | null;
  tone: ThemeBadgeTone;
}

export interface ThemeMetricResult {
  isEligible: boolean;
  stockCount: number;
  eligibleStockCount: number;
  risingCount: number;
  newHighCount: number;
  rsScore: number | null;
  changeRate: number | null;
  shortTermRs: number | null;
  momentum: number | null;
}

export interface RelatedThemeInput {
  themeCode: number;
  themeName?: string;
  rsScore: number;
  changeRate?: number;
  stockCodes: string[];
}

export interface RelatedThemeResult {
  themeCode: number;
  themeName: string;
  sharedStockCount: number;
  similarity: number;
  rsScore: number;
  changeRate: number;
  signal: ThemeDirection;
}

@Injectable()
export class ThemeMetricsService {
  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  calculateDailyMetric(stocks: ThemeMetricStock[], history: ThemeMetricHistory[]): ThemeMetricResult {
    const uniqueStocks = new Map(stocks.map((stock) => [stock.stockCode, stock]));
    const measurableStocks = [...uniqueStocks.values()];
    const average = (values: number[]): number | null =>
      values.length > 0 ? this.round2(values.reduce((sum, value) => sum + value, 0) / values.length) : null;

    const orderedHistory = [...history]
      .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
      .slice(-63);
    const shortTermHistory = orderedHistory.slice(-3);
    const hasCompleteShortTerm = shortTermHistory.length === 3;
    const shortTermRs = hasCompleteShortTerm
      ? average(shortTermHistory.map((item) => item.avgRsScore).filter((score) => score > 0))
      : null;
    const periodRs = hasCompleteShortTerm
      ? average(orderedHistory.map((item) => item.avgRsScore).filter((score) => score > 0))
      : null;

    return {
      isEligible: measurableStocks.length > 0,
      stockCount: uniqueStocks.size,
      eligibleStockCount: measurableStocks.length,
      risingCount: measurableStocks.filter((stock) => stock.changeRate > 0).length,
      newHighCount: measurableStocks.filter((stock) => stock.isNewHigh).length,
      rsScore: average(measurableStocks.map((stock) => stock.rsScore).filter((score) => score > 0)),
      changeRate: average(measurableStocks.map((stock) => stock.changeRate)),
      shortTermRs,
      momentum: shortTermRs != null && periodRs != null ? this.round2(shortTermRs - periodRs) : null,
    };
  }

  calculateStreak(
    changeRate: number,
    previous?: Pick<ThemeStreak, 'direction' | 'days'> | null,
  ): ThemeStreak {
    const direction: ThemeDirection = changeRate >= 0.5
      ? 'STRONG'
      : changeRate <= -0.5
        ? 'WEAK'
        : 'NEUTRAL';

    if (direction === 'NEUTRAL') {
      return { direction, days: 0, label: null, tone: null };
    }

    const days = previous?.direction === direction ? previous.days + 1 : 1;
    if (direction === 'STRONG') {
      return {
        direction,
        days,
        label: `${days}일 연속 강세`,
        tone: days >= 4 ? 'ORANGE' : 'RED',
      };
    }

    return {
      direction,
      days,
      label: days >= 2 ? `${days}일 연속 약세` : null,
      tone: days >= 2 ? 'BLUE' : null,
    };
  }

  calculateRelatedThemes(
    current: RelatedThemeInput,
    candidates: RelatedThemeInput[],
  ): RelatedThemeResult[] {
    const currentStocks = new Set(current.stockCodes);

    return candidates
      .filter((candidate) => candidate.themeCode !== current.themeCode)
      .map((candidate) => {
        const candidateStocks = new Set(candidate.stockCodes);
        const sharedStockCount = [...currentStocks].filter((code) => candidateStocks.has(code)).length;
        const unionSize = new Set([...currentStocks, ...candidateStocks]).size;
        return {
          themeCode: candidate.themeCode,
          themeName: candidate.themeName ?? '',
          sharedStockCount,
          similarity: unionSize > 0 ? this.round2(sharedStockCount / unionSize) : 0,
          rsScore: candidate.rsScore,
          changeRate: candidate.changeRate ?? 0,
          signal: this.toDirection(candidate.changeRate ?? 0),
        };
      })
      .filter((candidate) => candidate.sharedStockCount >= 2 && candidate.similarity >= 0.1)
      .sort((a, b) => b.similarity - a.similarity || b.rsScore - a.rsScore || a.themeCode - b.themeCode)
      .slice(0, 3);
  }

  private toDirection(changeRate: number): ThemeDirection {
    if (changeRate >= 0.5) return 'STRONG';
    if (changeRate <= -0.5) return 'WEAK';
    return 'NEUTRAL';
  }
}
