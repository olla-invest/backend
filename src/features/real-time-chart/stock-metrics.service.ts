import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../../generated/prisma';

@Injectable()
export class StockMetricsService {
  private readonly logger = new Logger(StockMetricsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * 특정 거래일의 종목별 지표 조회
   */
  async getMetricsForDate(
    stockCodes: string[],
    tradeDate: Date,
  ): Promise<Map<string, any>> {
    const metrics = await this.prisma.stockDailyMetrics.findMany({
      where: {
        stockCode: { in: stockCodes },
        tradeDate,
      },
    });

    const metricsMap = new Map<string, any>();
    metrics.forEach((metric) => {
      metricsMap.set(metric.stockCode, {
        relativeStrengthScore: Number(metric.relativeStrengthScore),
        rank: metric.rank,
        isNewHigh: metric.isNewHigh,
        closePrice: Number(metric.closePrice),
        priceChange1d: metric.priceChange1d ? Number(metric.priceChange1d) : null,
        priceChangeRate1d: metric.priceChangeRate1d
          ? Number(metric.priceChangeRate1d)
          : null,
        tradingValue: metric.tradingValue ? Number(metric.tradingValue) : 0,
      });
    });

    return metricsMap;
  }

  /**
   * 최신 거래일 조회
   */
  async getLatestTradeDate(marketType?: string): Promise<Date | null> {
    const where = marketType ? { marketType } : {};
    const latestDate = await this.prisma.stockDailyMetrics.findFirst({
      where,
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true },
    });
    return latestDate?.tradeDate || null;
  }

  /**
   * 최신 거래일의 종목별 지표 조회 (날짜 상관없이 가장 최근 데이터)
   */
  async getLatestMetrics(stockCodes: string[], marketType?: string): Promise<Map<string, any>> {
    const latestDate = await this.getLatestTradeDate(marketType);

    if (!latestDate) {
      return new Map();
    }

    return this.getMetricsForDate(stockCodes, latestDate);
  }

  /**
   * 최근 N일간의 순위 변동 조회
   */
  async getRankingHistory(
    stockCode: string,
    days: number = 4,
  ): Promise<number[]> {
    const metrics = await this.prisma.stockDailyMetrics.findMany({
      where: { stockCode },
      orderBy: { tradeDate: 'desc' },
      take: days,
      select: { rank: true, tradeDate: true },
    });

    this.logger.debug(`RankHistory for ${stockCode}: ${JSON.stringify(metrics)}`);

    return metrics.map((m) => m.rank);
  }

  /**
   * 여러 종목의 최근 N개 거래일 지표 이력 조회
   * 반환: Map<stockCode, Array<{tradeDate, rank, rsScore}>>
   */
  async getRecentMetricsHistory(
    stockCodes: string[],
    days: number = 4,
  ): Promise<Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>> {
    // 최근 N개 거래일 조회
    const recentDates = await this.prisma.stockDailyMetrics.findMany({
      orderBy: { tradeDate: 'desc' },
      take: days,
      distinct: ['tradeDate'],
      select: { tradeDate: true },
    });

    if (recentDates.length === 0) {
      return new Map();
    }

    const tradeDates = recentDates.map((d) => d.tradeDate);

    // 해당 종목들의 최근 N개 거래일 지표 조회
    const metrics = await this.prisma.stockDailyMetrics.findMany({
      where: {
        stockCode: { in: stockCodes },
        tradeDate: { in: tradeDates },
      },
      orderBy: [
        { stockCode: 'asc' },
        { tradeDate: 'desc' },
      ],
      select: {
        stockCode: true,
        tradeDate: true,
        rank: true,
        relativeStrengthScore: true,
      },
    });

    // 종목별로 그룹핑
    const historyMap = new Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>();

    for (const metric of metrics) {
      if (!historyMap.has(metric.stockCode)) {
        historyMap.set(metric.stockCode, []);
      }
      historyMap.get(metric.stockCode)!.push({
        tradeDate: metric.tradeDate,
        rank: metric.rank,
        rsScore: Number(metric.relativeStrengthScore),
      });
    }

    return historyMap;
  }

  /**
   * 런타임에 커스텀 RS 계산 (사용자 설정 기간 + 가중치)
   *
   * @param stockCodes - 대상 종목 코드 목록
   * @param periods - RS 계산 기간 배열 (예: [63, 126, 252])
   * @param weights - RS 가중치 배열 (예: [50, 30, 20])
   * @param indexCode - 지수 코드 (INDEX_KOSPI, INDEX_KOSDAQ)
   * @param tradingDays - 계산할 거래일 수 (기본 4: 당일, D-1, D-2, D-3)
   *
   * @returns Map<stockCode, Array<{tradeDate, rank, rsScore}>> - 종목별 최근 N일 랭크 이력
   */
  async calculateRuntimeRS(
    stockCodes: string[],
    periods: number[],
    weights: number[],
    indexCode: string,
    tradingDays: number = 4,
  ): Promise<Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>> {
    this.logger.log(
      `Calculating runtime RS for ${stockCodes.length} stocks, periods: ${periods}, weights: ${weights}, index: ${indexCode}`,
    );

    // 최근 N개 거래일 조회
    const recentDates = await this.prisma.stockCandle.findMany({
      where: {
        candleType: 'day',
        stockCode: { not: { startsWith: 'INDEX_' } },
      },
      orderBy: { candleTime: 'desc' },
      take: tradingDays,
      distinct: ['candleTime'],
      select: { candleTime: true },
    });

    if (recentDates.length === 0) {
      this.logger.warn('No trading days found');
      return new Map();
    }

    const tradeDates = recentDates.map((d) => d.candleTime);
    this.logger.log(`Found ${tradeDates.length} recent trading days`);

    // 최대 기간 계산 (52주 = 365일)
    const maxPeriod = Math.max(...periods);
    const historicalCutoff = new Date(tradeDates[0]);
    historicalCutoff.setDate(historicalCutoff.getDate() - Math.max(365, maxPeriod + 10));

    // 일봉 데이터 조회
    const [stockCandles, indexCandles] = await Promise.all([
      this.prisma.stockCandle.findMany({
        where: {
          candleType: 'day',
          stockCode: { in: stockCodes },
          candleTime: { gte: historicalCutoff },
        },
        orderBy: [{ stockCode: 'asc' }, { candleTime: 'asc' }],
      }),
      this.prisma.stockCandle.findMany({
        where: {
          stockCode: indexCode,
          candleType: 'day',
          candleTime: { gte: historicalCutoff },
        },
        orderBy: { candleTime: 'asc' },
      }),
    ]);

    this.logger.log(`Loaded ${stockCandles.length} stock candles, ${indexCandles.length} index candles`);

    // 종목별 그룹핑
    const candlesByStock = new Map<string, typeof stockCandles>();
    for (const candle of stockCandles) {
      if (!candlesByStock.has(candle.stockCode)) {
        candlesByStock.set(candle.stockCode, []);
      }
      candlesByStock.get(candle.stockCode)!.push(candle);
    }

    // 각 거래일별로 RS 계산 및 랭킹
    const resultMap = new Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>();

    for (const tradeDate of tradeDates) {
      const tradeDateOnly = new Date(tradeDate);
      tradeDateOnly.setHours(0, 0, 0, 0);

      // 해당 거래일의 지수 데이터 찾기
      const indexCandlesUpToDate = indexCandles.filter((c) => c.candleTime <= tradeDate);
      if (indexCandlesUpToDate.length === 0) continue;

      const latestIndexCandle = indexCandlesUpToDate[indexCandlesUpToDate.length - 1];
      const indexCloseNow = latestIndexCandle.closePrice.toNumber();

      // 각 종목별 RS 계산 + 필터 적용
      const stockData: Array<{ stockCode: string; rsRaw: number; passedFilters: boolean }> = [];
      const MIN_TRADING_VALUE = 1_000_000_000; // 10억

      for (const [stockCode, candles] of candlesByStock) {
        const candlesUpToDate = candles.filter((c) => c.candleTime <= tradeDate);
        if (candlesUpToDate.length === 0) continue;

        const latest = candlesUpToDate[candlesUpToDate.length - 1];
        const closePrice = latest.closePrice.toNumber();

        // 52주 고/저가
        let high52w = -Infinity;
        let low52w = Infinity;
        for (const c of candlesUpToDate) {
          const h = c.highPrice.toNumber();
          const l = c.lowPrice.toNumber();
          if (h > high52w) high52w = h;
          if (l < low52w) low52w = l;
        }

        // MA200 (현재)
        const ma200Slice = candlesUpToDate.slice(-200);
        const ma200 = ma200Slice.length >= 200
          ? ma200Slice.reduce((sum, c) => sum + c.closePrice.toNumber(), 0) / 200
          : null;

        // MA200 (20일 전)
        const ma200_20dSlice = candlesUpToDate.length >= 220
          ? candlesUpToDate.slice(-(200 + 20), -20)
          : [];
        const ma200_20d = ma200_20dSlice.length >= 200
          ? ma200_20dSlice.reduce((sum, c) => sum + c.closePrice.toNumber(), 0) / 200
          : null;

        // 거래대금
        const tradingValue = latest.tradingValue
          ? Number(latest.tradingValue)
          : closePrice * Number(latest.volume);

        // 여러 기간의 RS 계산
        const rsValues: number[] = [];
        for (const period of periods) {
          if (candlesUpToDate.length <= period) {
            rsValues.push(0);
            continue;
          }

          const pastPrice = candlesUpToDate[candlesUpToDate.length - 1 - period].closePrice.toNumber();

          // 해당 기간의 지수 과거가
          const indexPastCandles = indexCandles.filter((c) => c.candleTime <= tradeDate);
          if (indexPastCandles.length <= period) {
            rsValues.push(0);
            continue;
          }
          const indexPastPrice = indexPastCandles[indexPastCandles.length - 1 - period].closePrice.toNumber();

          if (pastPrice > 0 && indexPastPrice > 0) {
            const stockReturn = closePrice / pastPrice;
            const indexReturn = indexCloseNow / indexPastPrice;
            rsValues.push(stockReturn / indexReturn);
          } else {
            rsValues.push(0);
          }
        }

        // 가중 평균 계산
        let weightedRS = 0;
        let totalWeight = 0;
        for (let i = 0; i < rsValues.length; i++) {
          if (rsValues[i] > 0) {
            weightedRS += rsValues[i] * weights[i];
            totalWeight += weights[i];
          }
        }

        if (totalWeight > 0) {
          weightedRS /= totalWeight;

          // 5가지 필터
          const f1 = closePrice >= low52w * 1.3;                          // 현재가 >= 52주저 × 1.3
          const f2 = closePrice >= 0.75 * high52w;                        // 현재가 >= 0.75 × 52주고
          const f3 = ma200 !== null && ma200_20d !== null && ma200 > ma200_20d; // MA200 상승추세
          const f4 = weightedRS > 0;                                      // RS 계산 가능
          const f5 = tradingValue >= MIN_TRADING_VALUE;                   // 거래대금 >= 10억

          const passedFilters = f1 && f2 && f3 && f4 && f5;
          stockData.push({ stockCode, rsRaw: weightedRS, passedFilters });
        }
      }

      // 필터 통과 종목만 RS 기준 정렬 및 랭킹
      const filtered = stockData.filter((s) => s.passedFilters);
      filtered.sort((a, b) => b.rsRaw - a.rsRaw);

      const totalStocks = filtered.length;
      for (let i = 0; i < totalStocks; i++) {
        const { stockCode } = filtered[i];
        const rank = i + 1;
        // 상위 % 계산 → 1~99 점수 변환
        const topPercent = (rank / totalStocks) * 100;
        const score = this.percentileToScore(topPercent);

        if (!resultMap.has(stockCode)) {
          resultMap.set(stockCode, []);
        }
        resultMap.get(stockCode)!.push({
          tradeDate: tradeDateOnly,
          rank,
          rsScore: score,
        });
      }
    }

    this.logger.log(`Runtime RS calculation completed for ${resultMap.size} stocks`);
    return resultMap;
  }

  /**
   * 기간 기반 RS 계산 (rsStartDate와 rsEndDate 사용)
   * endDate 종가를 기준으로 startDate 가격까지의 수익률 계산
   */
  async calculateRangeRS(
    stockCodes: string[],
    rsFilters: Array<{
      rsStartDate: string;
      rsEndDate: string;
      strength: number;
    }>,
    indexCode: string,
    tradingDays: number = 4,
  ): Promise<Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>> {
    this.logger.log(
      `Calculating range RS for ${stockCodes.length} stocks, filters: ${JSON.stringify(rsFilters)}, index: ${indexCode}`,
    );

    // 최근 N개 거래일 조회
    const recentDates = await this.prisma.stockCandle.findMany({
      where: {
        candleType: 'day',
        stockCode: { not: { startsWith: 'INDEX_' } },
      },
      orderBy: { candleTime: 'desc' },
      take: tradingDays,
      distinct: ['candleTime'],
      select: { candleTime: true },
    });

    if (recentDates.length === 0) {
      this.logger.warn('No trading days found');
      return new Map();
    }

    const tradeDates = recentDates.map((d) => d.candleTime);
    this.logger.log(`Found ${tradeDates.length} recent trading days`);

    // 날짜를 일수로 변환
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const periodsData: Array<{ startDays: number; endDays: number; weight: number }> = [];
    let maxDays = 0;

    for (const filter of rsFilters) {
      const startDays = this.convertDateToDays(filter.rsStartDate, today);
      const endDays = this.convertDateToDays(filter.rsEndDate, today);
      periodsData.push({ startDays, endDays, weight: filter.strength });
      maxDays = Math.max(maxDays, startDays); // startDays가 더 크므로 (더 과거)
    }

    // 과거 데이터 조회 범위
    const historicalCutoff = new Date(tradeDates[0]);
    historicalCutoff.setDate(historicalCutoff.getDate() - Math.max(365, maxDays + 10));

    // 일봉 데이터 조회
    const [stockCandles, indexCandles] = await Promise.all([
      this.prisma.stockCandle.findMany({
        where: {
          candleType: 'day',
          stockCode: { in: stockCodes },
          candleTime: { gte: historicalCutoff },
        },
        orderBy: [{ stockCode: 'asc' }, { candleTime: 'asc' }],
      }),
      this.prisma.stockCandle.findMany({
        where: {
          stockCode: indexCode,
          candleType: 'day',
          candleTime: { gte: historicalCutoff },
        },
        orderBy: { candleTime: 'asc' },
      }),
    ]);

    this.logger.log(`Loaded ${stockCandles.length} stock candles, ${indexCandles.length} index candles`);

    // 종목별 그룹핑
    const candlesByStock = new Map<string, typeof stockCandles>();
    for (const candle of stockCandles) {
      if (!candlesByStock.has(candle.stockCode)) {
        candlesByStock.set(candle.stockCode, []);
      }
      candlesByStock.get(candle.stockCode)!.push(candle);
    }

    // 각 거래일별로 RS 계산 및 랭킹
    const resultMap = new Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>();

    for (const tradeDate of tradeDates) {
      const tradeDateOnly = new Date(tradeDate);
      tradeDateOnly.setHours(0, 0, 0, 0);

      // 해당 거래일의 지수 데이터
      const indexCandlesUpToDate = indexCandles.filter((c) => c.candleTime <= tradeDate);
      if (indexCandlesUpToDate.length === 0) continue;

      const MIN_TRADING_VALUE = 1_000_000_000; // 10억

      // 필터 통과 종목 Set (여러 필터 중 하나라도 통과하면 포함)
      const passedStockCodes = new Set<string>();
      // 종목별 RS 값 저장
      const stockRSMap = new Map<string, number>();

      // 디버그: 필터별 탈락 카운트
      const filterStats = { total: 0, f1Fail: 0, f2Fail: 0, f3Fail: 0, f4Fail: 0, f5Fail: 0, noData: 0, passed: 0 };

      for (const [stockCode, candles] of candlesByStock) {
        const candlesUpToDate = candles.filter((c) => c.candleTime <= tradeDate);
        if (candlesUpToDate.length === 0) continue;

        // 여러 기간의 RS 계산
        const rsValues: number[] = [];
        const weights: number[] = [];
        let anyFilterPassed = false;

        for (const periodData of periodsData) {
          const { startDays, endDays, weight } = periodData;

          // 목표 날짜 계산 (달력 기준)
          const targetStartDate = new Date(tradeDateOnly);
          targetStartDate.setDate(tradeDateOnly.getDate() - startDays);
          const targetEndDate = new Date(tradeDateOnly);
          targetEndDate.setDate(tradeDateOnly.getDate() - endDays);

          // startDate: 목표일 이상의 가장 가까운 거래일 (미래 방향)
          const startCandle = candlesUpToDate.find((c) => c.candleTime >= targetStartDate);
          // endDate: 목표일 이하의 가장 최근 거래일 (과거 방향)
          const endCandle = [...candlesUpToDate].reverse().find((c) => c.candleTime <= targetEndDate);

          if (!startCandle || !endCandle) continue;

          // 지수도 동일한 방식으로 찾기
          const indexStartCandle = indexCandlesUpToDate.find((c) => c.candleTime >= targetStartDate);
          const indexEndCandle = [...indexCandlesUpToDate].reverse().find((c) => c.candleTime <= targetEndDate);

          if (!indexStartCandle || !indexEndCandle) continue;

          // === endDate 기준으로 필터 조건 계산 ===
          const candlesUpToEndDate = candlesUpToDate.filter((c) => c.candleTime <= endCandle.candleTime);
          const closePrice = endCandle.closePrice.toNumber();

          // 52주 고/저가 (endDate 기준)
          let high52w = -Infinity;
          let low52w = Infinity;
          for (const c of candlesUpToEndDate) {
            const h = c.highPrice.toNumber();
            const l = c.lowPrice.toNumber();
            if (h > high52w) high52w = h;
            if (l < low52w) low52w = l;
          }

          // MA200 (endDate 기준)
          const ma200Slice = candlesUpToEndDate.slice(-200);
          const ma200 = ma200Slice.length >= 200
            ? ma200Slice.reduce((sum, c) => sum + c.closePrice.toNumber(), 0) / 200
            : null;

          // MA200 (20일 전, endDate 기준)
          const ma200_20dSlice = candlesUpToEndDate.length >= 220
            ? candlesUpToEndDate.slice(-(200 + 20), -20)
            : [];
          const ma200_20d = ma200_20dSlice.length >= 200
            ? ma200_20dSlice.reduce((sum, c) => sum + c.closePrice.toNumber(), 0) / 200
            : null;

          // 거래대금 (endDate 기준)
          const tradingValue = endCandle.tradingValue
            ? Number(endCandle.tradingValue)
            : closePrice * Number(endCandle.volume);

          // RS 계산
          const startPrice = startCandle.closePrice.toNumber();
          const endPrice = endCandle.closePrice.toNumber();
          const indexStartPrice = indexStartCandle.closePrice.toNumber();
          const indexEndPrice = indexEndCandle.closePrice.toNumber();

          if (endPrice > 0 && indexEndPrice > 0) {
            const stockReturn = startPrice / endPrice;
            const indexReturn = indexStartPrice / indexEndPrice;
            const rs = stockReturn / indexReturn;

            rsValues.push(rs);
            weights.push(weight);

            // 이 필터(endDate) 기준 5가지 조건 체크
            const f1 = closePrice >= low52w * 1.3;                          // 현재가 >= 52주저 × 1.3
            const f2 = closePrice >= 0.75 * high52w;                        // 현재가 >= 0.75 × 52주고
            const f3 = ma200 !== null && ma200_20d !== null && ma200 > ma200_20d; // MA200 상승추세
            const f4 = rs > 0;                                              // RS 계산 가능
            const f5 = tradingValue >= MIN_TRADING_VALUE;                   // 거래대금 >= 10억

            filterStats.total++;
            if (!f1) filterStats.f1Fail++;
            if (!f2) filterStats.f2Fail++;
            if (!f3) filterStats.f3Fail++;
            if (!f4) filterStats.f4Fail++;
            if (!f5) filterStats.f5Fail++;

            if (f1 && f2 && f3 && f4 && f5) {
              anyFilterPassed = true;
              filterStats.passed++;
            }
          } else {
            filterStats.noData++;
          }
        }

        // 가중 평균 RS 계산
        let weightedRS = 0;
        let totalWeight = 0;
        for (let i = 0; i < rsValues.length; i++) {
          if (rsValues[i] > 0) {
            weightedRS += rsValues[i] * weights[i];
            totalWeight += weights[i];
          }
        }

        if (totalWeight > 0) {
          weightedRS /= totalWeight;
          stockRSMap.set(stockCode, weightedRS);

          if (anyFilterPassed) {
            passedStockCodes.add(stockCode);
          }
        }
      }

      // 디버그 로그: 필터별 탈락 현황
      this.logger.log(
        `[Range RS Filter Stats] Total: ${filterStats.total}, Passed: ${filterStats.passed}, ` +
        `F1(52w low): ${filterStats.f1Fail}, F2(52w high): ${filterStats.f2Fail}, ` +
        `F3(MA200): ${filterStats.f3Fail}, F4(RS>0): ${filterStats.f4Fail}, F5(거래대금): ${filterStats.f5Fail}, NoData: ${filterStats.noData}`,
      );

      // 필터 통과 종목만 RS 기준 정렬 및 랭킹
      const filtered = Array.from(passedStockCodes).map((code) => ({
        stockCode: code,
        rsRaw: stockRSMap.get(code) || 0,
      }));
      filtered.sort((a, b) => b.rsRaw - a.rsRaw);

      const totalStocks = filtered.length;
      for (let i = 0; i < totalStocks; i++) {
        const { stockCode } = filtered[i];
        const rank = i + 1;
        // 상위 % 계산 → 1~99 점수 변환
        const topPercent = (rank / totalStocks) * 100;
        const score = this.percentileToScore(topPercent);

        if (!resultMap.has(stockCode)) {
          resultMap.set(stockCode, []);
        }
        resultMap.get(stockCode)!.push({
          tradeDate: tradeDateOnly,
          rank,
          rsScore: score,
        });
      }
    }

    this.logger.log(`Range RS calculation completed for ${resultMap.size} stocks`);
    return resultMap;
  }

  /**
   * 날짜 문자열을 오늘로부터 며칠 전인지 계산
   */
  private convertDateToDays(dateStr: string, today: Date): number {
    let date: Date;
    if (dateStr.includes('-')) {
      date = new Date(dateStr);
    } else if (dateStr.length === 8) {
      const year = dateStr.substring(0, 4);
      const month = dateStr.substring(4, 6);
      const day = dateStr.substring(6, 8);
      date = new Date(`${year}-${month}-${day}`);
    } else {
      return 63;
    }

    if (isNaN(date.getTime())) {
      return 63;
    }

    date.setHours(0, 0, 0, 0);
    const diffMs = today.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    return diffDays > 0 ? diffDays : 1;
  }

  /**
   * 전체 종목의 일별 지표 계산 및 저장
   *
   * 처리 순서:
   * 1. DB에서 전체 일봉 + 지수 일봉 한번에 조회
   * 2. 종목별 7개 필터 적용
   * 3. 필터 통과 종목의 RS(63) 계산
   * 4. RS 내림차순 정렬 → 상위% → 1~99 점수
   * 5. 랭킹 부여 및 DB 저장
   */
  /**
   * 최근 N개 거래일 날짜 조회
   */
  async getRecentTradingDates(count: number = 4): Promise<Date[]> {
    const recentDates = await this.prisma.stockCandle.findMany({
      where: {
        candleType: 'day',
        stockCode: { not: { startsWith: 'INDEX_' } },
      },
      orderBy: { candleTime: 'desc' },
      take: count,
      distinct: ['candleTime'],
      select: { candleTime: true },
    });
    return recentDates.map((r) => r.candleTime);
  }

  async calculateAndSaveDailyMetrics(
    marketType: '0' | '10' | 'all' = 'all',
    tradeDate?: Date,
    indexCode: string = 'INDEX_KOSPI',
    stockCodes?: string[],
    stockIndexMap?: Map<string, string>,
  ) {
    const targetDate = tradeDate || new Date();
    targetDate.setHours(0, 0, 0, 0);

    this.logger.log(
      `Starting metrics calculation for ${marketType} on ${targetDate.toISOString().split('T')[0]}, index: ${indexCode}${stockIndexMap ? ' (multi-index)' : ''}`,
    );

    // 1. 모든 일봉 데이터 한번에 조회 (52주 = 365일)
    const historicalCutoff = new Date(targetDate);
    historicalCutoff.setDate(historicalCutoff.getDate() - 365);

    // 필요한 지수 목록 결정
    const indexCodesToLoad = stockIndexMap
      ? [...new Set(stockIndexMap.values())]
      : [indexCode];

    // 종목 캔들 + 모든 필요 지수 캔들 병렬 조회
    const [allCandles, ...indexResultArrays] = await Promise.all([
      this.prisma.stockCandle.findMany({
        where: {
          candleType: 'day',
          candleTime: { gte: historicalCutoff, lte: targetDate },
          stockCode: stockCodes
            ? { in: stockCodes }
            : { not: { startsWith: 'INDEX_' } },
        },
        orderBy: [{ stockCode: 'asc' }, { candleTime: 'asc' }],
      }),
      ...indexCodesToLoad.map((idx) =>
        this.prisma.stockCandle.findMany({
          where: {
            stockCode: idx,
            candleType: 'day',
            candleTime: { gte: historicalCutoff, lte: targetDate },
          },
          orderBy: { candleTime: 'asc' },
        }),
      ),
    ]);

    // 지수 캔들 맵 구성
    const indexCandlesMap = new Map<string, typeof allCandles>();
    indexCodesToLoad.forEach((idx, i) => {
      indexCandlesMap.set(idx, indexResultArrays[i]);
    });

    this.logger.log(
      `Loaded ${allCandles.length} stock candles, indices: ${indexCodesToLoad.map((idx) => `${idx}(${indexCandlesMap.get(idx)?.length || 0})`).join(', ')}`,
    );

    if (indexResultArrays.every((arr) => arr.length === 0)) {
      this.logger.warn(`No index candles found. Cannot calculate RS.`);
      return { success: false, count: 0, date: targetDate };
    }

    // 종목별 그룹핑
    const candlesByStock = new Map<string, typeof allCandles>();
    for (const candle of allCandles) {
      if (!candlesByStock.has(candle.stockCode)) {
        candlesByStock.set(candle.stockCode, []);
      }
      candlesByStock.get(candle.stockCode)!.push(candle);
    }

    // 2. 각 종목별 계산
    const MIN_TRADING_VALUE = 1_000_000_000; // 10억

    interface StockCalc {
      stockCode: string;
      closePrice: number;
      high52w: number;
      low52w: number;
      isNewHigh: boolean;
      priceChange1d: number;
      priceChangeRate1d: number;
      volume: bigint;
      tradingValue: bigint;
      rsRaw: number;
      passedFilters: boolean;
      candleTime: Date;
      rsScore?: number;
      rank?: number;
    }

    const calculations: StockCalc[] = [];

    // 디버그: 필터별 탈락 통계
    const filterStats = { total: 0, f1Fail: 0, f2Fail: 0, f3Fail: 0, f4Fail: 0, f5Fail: 0, passed: 0 };
    const filterFailDetails: Array<{ stockCode: string; f1: boolean; f2: boolean; f3: boolean; f4: boolean; f5: boolean; closePrice: number; low52w: number; high52w: number; ma200: number | null; ma200_20d: number | null; rsRaw: number; tradingValue: number; candleCount: number }> = [];

    for (const [stockCode, candles] of candlesByStock) {
      if (candles.length === 0) continue;

      const latest = candles[candles.length - 1];
      const closePrice = latest.closePrice.toNumber();

      // 52주 고/저가
      let high52w = -Infinity;
      let low52w = Infinity;
      for (const c of candles) {
        const h = c.highPrice.toNumber();
        const l = c.lowPrice.toNumber();
        if (h > high52w) high52w = h;
        if (l < low52w) low52w = l;
      }

      // 전일 종가
      const prev = candles.length >= 2 ? candles[candles.length - 2] : null;
      const prevClose = prev ? prev.closePrice.toNumber() : 0;

      // MA200 (현재)
      const ma200Slice = candles.slice(-200);
      const ma200 = ma200Slice.length >= 200
        ? ma200Slice.reduce((sum, c) => sum + c.closePrice.toNumber(), 0) / 200
        : null;

      // MA200 (20일 전)
      const ma200_20dSlice = candles.length >= 220
        ? candles.slice(-(200 + 20), -20)
        : [];
      const ma200_20d = ma200_20dSlice.length >= 200
        ? ma200_20dSlice.reduce((sum, c) => sum + c.closePrice.toNumber(), 0) / 200
        : null;

      // RS(63): 종목별로 자기 시장 지수 사용
      const stockIdxCode = stockIndexMap?.get(stockCode) || indexCode;
      const stockIdxCandles = indexCandlesMap.get(stockIdxCode) || [];
      const idxCloseNow = stockIdxCandles.length > 0
        ? stockIdxCandles[stockIdxCandles.length - 1].closePrice.toNumber()
        : 0;
      const idx63Ago = stockIdxCandles.length > 63
        ? stockIdxCandles[stockIdxCandles.length - 64].closePrice.toNumber()
        : null;

      const close63Ago = candles.length > 63
        ? candles[candles.length - 64].closePrice.toNumber()
        : null;

      let rsRaw = 0;
      if (close63Ago && close63Ago > 0 && idx63Ago && idx63Ago > 0) {
        const stockReturn = closePrice / close63Ago;
        const indexReturn = idxCloseNow / idx63Ago;
        rsRaw = stockReturn / indexReturn;
      }

      // 거래대금 (DB에 tradingValue 있으면 사용, 없으면 종가×거래량 근사)
      const tradingValue = latest.tradingValue
        ? Number(latest.tradingValue)
        : closePrice * Number(latest.volume);

      // === 5개 필터 ===
      const f1 = closePrice >= low52w * 1.3;                          // 현재가 >= 52주저 × 1.3
      const f2 = closePrice >= 0.75 * high52w;                        // 현재가 >= 0.75 × 52주고
      const f3 = ma200 !== null && ma200_20d !== null && ma200 > ma200_20d; // MA200 상승추세
      const f4 = rsRaw > 0;                                            // RS 계산 가능
      const f5 = tradingValue >= MIN_TRADING_VALUE;                    // 거래대금 >= 10억

      const passedFilters = f1 && f2 && f3 && f4 && f5;

      // 디버그 통계 수집
      filterStats.total++;
      if (!f1) filterStats.f1Fail++;
      if (!f2) filterStats.f2Fail++;
      if (!f3) filterStats.f3Fail++;
      if (!f4) filterStats.f4Fail++;
      if (!f5) filterStats.f5Fail++;
      if (passedFilters) filterStats.passed++;

      // 필터 실패 종목 상세 (나중에 비교용)
      if (!passedFilters) {
        filterFailDetails.push({
          stockCode, f1, f2, f3, f4, f5,
          closePrice, low52w, high52w, ma200, ma200_20d, rsRaw, tradingValue,
          candleCount: candles.length,
        });
      }

      const isNewHigh = latest.highPrice.toNumber() >= high52w;

      calculations.push({
        stockCode,
        closePrice,
        high52w,
        low52w,
        isNewHigh,
        priceChange1d: closePrice - prevClose,
        priceChangeRate1d: prevClose > 0 ? ((closePrice - prevClose) / prevClose) * 100 : 0,
        volume: latest.volume,
        tradingValue: BigInt(Math.floor(tradingValue)),
        rsRaw,
        passedFilters,
        candleTime: latest.candleTime,
      });
    }

    // 3. 필터 통과 종목 → RS 내림차순 정렬 → 점수 + 랭킹
    const filtered = calculations.filter((c) => c.passedFilters);
    filtered.sort((a, b) => b.rsRaw - a.rsRaw);

    const totalFiltered = filtered.length;
    this.logger.log(`Filter passed: ${totalFiltered} / ${calculations.length} stocks`);
    this.logger.log(
      `[Filter Stats] Total: ${filterStats.total}, Passed: ${filterStats.passed}, ` +
      `F1(52w low×1.3): ${filterStats.f1Fail} fail, F2(75% of 52w high): ${filterStats.f2Fail} fail, ` +
      `F3(MA200 uptrend): ${filterStats.f3Fail} fail, F4(RS>0): ${filterStats.f4Fail} fail, F5(거래대금>=10억): ${filterStats.f5Fail} fail`,
    );
    // 필터 실패 종목 샘플 로그 (처음 20개)
    if (filterFailDetails.length > 0) {
      const sampleFails = filterFailDetails.slice(0, 20);
      for (const d of sampleFails) {
        const failReasons: string[] = [];
        if (!d.f1) failReasons.push(`F1(price ${d.closePrice} < low52w*1.3 ${(d.low52w * 1.3).toFixed(0)})`);
        if (!d.f2) failReasons.push(`F2(price ${d.closePrice} < 75%high52w ${(d.high52w * 0.75).toFixed(0)})`);
        if (!d.f3) failReasons.push(`F3(MA200: ${d.ma200?.toFixed(0) ?? 'null'} vs 20d ago: ${d.ma200_20d?.toFixed(0) ?? 'null'})`);
        if (!d.f4) failReasons.push(`F4(RS=${d.rsRaw.toFixed(4)})`);
        if (!d.f5) failReasons.push(`F5(거래대금=${(d.tradingValue / 1e8).toFixed(0)}억 < 10억)`);
        this.logger.debug(`[FilterFail] ${d.stockCode}: ${failReasons.join(', ')} (candles: ${d.candleCount})`);
      }
    }

    for (let i = 0; i < filtered.length; i++) {
      const topPercent = ((i + 1) / totalFiltered) * 100;
      filtered[i].rsScore = this.percentileToScore(topPercent);
      filtered[i].rank = i + 1;
    }

    // 필터 미통과 종목: 점수 0, 랭크 0
    for (const calc of calculations) {
      if (!calc.passedFilters) {
        calc.rsScore = 0;
        calc.rank = 0;
      }
    }

    // 4. DB에 저장 (배치 upsert)
    this.logger.log(`Saving metrics for ${calculations.length} stocks...`);

    const SAVE_BATCH = 50;
    for (let i = 0; i < calculations.length; i += SAVE_BATCH) {
      const batch = calculations.slice(i, i + SAVE_BATCH);

      await Promise.all(
        batch.map((calc) => {
          const data = {
            stockCode: calc.stockCode,
            tradeDate: new Date(calc.candleTime.getTime()),
            closePrice: new Prisma.Decimal(calc.closePrice),
            relativeStrengthScore: new Prisma.Decimal(calc.rsScore ?? 0),
            rank: calc.rank ?? 0,
            marketType,
            isNewHigh: calc.isNewHigh,
            highPrice52w: new Prisma.Decimal(calc.high52w),
            lowPrice52w: new Prisma.Decimal(calc.low52w),
            priceChange1d: new Prisma.Decimal(calc.priceChange1d),
            priceChangeRate1d: new Prisma.Decimal(calc.priceChangeRate1d),
            volume1d: calc.volume,
            tradingValue: calc.tradingValue,
          };

          // tradeDate를 날짜만 사용 (시간 제거)
          data.tradeDate.setHours(0, 0, 0, 0);

          return this.prisma.stockDailyMetrics.upsert({
            where: {
              stockCode_tradeDate: {
                stockCode: calc.stockCode,
                tradeDate: data.tradeDate,
              },
            },
            create: data,
            update: data,
          });
        }),
      );
    }

    this.logger.log(
      `Metrics calculation completed: ${calculations.length} total, ${totalFiltered} filtered, saved.`,
    );

    this.eventEmitter.emit('metrics.updated', {
      tradeDate: targetDate.toISOString().split('T')[0],
      filteredCount: totalFiltered,
    });

    return {
      success: true,
      count: calculations.length,
      filtered: totalFiltered,
      date: targetDate,
    };
  }

  /**
   * 디버그: 특정 종목들의 필터 상세 결과 조회
   * 종목별로 5개 필터 통과/실패 여부와 상세 값을 반환
   */
  async debugFilterCheck(
    stockCodes: string[],
    stockIndexMap?: Map<string, string>,
    indexCode: string = 'INDEX_KOSPI',
  ) {
    const targetDate = new Date();
    targetDate.setHours(0, 0, 0, 0);

    const historicalCutoff = new Date(targetDate);
    historicalCutoff.setDate(historicalCutoff.getDate() - 365);

    const indexCodesToLoad = stockIndexMap
      ? [...new Set(stockIndexMap.values())]
      : [indexCode];

    const [allCandles, ...indexResultArrays] = await Promise.all([
      this.prisma.stockCandle.findMany({
        where: {
          candleType: 'day',
          candleTime: { gte: historicalCutoff, lte: targetDate },
          stockCode: { in: stockCodes },
        },
        orderBy: [{ stockCode: 'asc' }, { candleTime: 'asc' }],
      }),
      ...indexCodesToLoad.map((idx) =>
        this.prisma.stockCandle.findMany({
          where: {
            stockCode: idx,
            candleType: 'day',
            candleTime: { gte: historicalCutoff, lte: targetDate },
          },
          orderBy: { candleTime: 'asc' },
        }),
      ),
    ]);

    const indexCandlesMap = new Map<string, typeof allCandles>();
    indexCodesToLoad.forEach((idx, i) => {
      indexCandlesMap.set(idx, indexResultArrays[i]);
    });

    const candlesByStock = new Map<string, typeof allCandles>();
    for (const candle of allCandles) {
      if (!candlesByStock.has(candle.stockCode)) {
        candlesByStock.set(candle.stockCode, []);
      }
      candlesByStock.get(candle.stockCode)!.push(candle);
    }

    const MIN_TRADING_VALUE = 1_000_000_000;
    const results: Array<{
      stockCode: string;
      hasData: boolean;
      candleCount: number;
      closePrice: number;
      low52w: number;
      high52w: number;
      ma200: number | null;
      ma200_20d: number | null;
      rsRaw: number;
      tradingValue: number;
      f1: boolean; f1Detail: string;
      f2: boolean; f2Detail: string;
      f3: boolean; f3Detail: string;
      f4: boolean; f4Detail: string;
      f5: boolean; f5Detail: string;
      passedAll: boolean;
    }> = [];

    for (const stockCode of stockCodes) {
      const candles = candlesByStock.get(stockCode);
      if (!candles || candles.length === 0) {
        results.push({
          stockCode, hasData: false, candleCount: 0,
          closePrice: 0, low52w: 0, high52w: 0, ma200: null, ma200_20d: null, rsRaw: 0, tradingValue: 0,
          f1: false, f1Detail: 'No candle data',
          f2: false, f2Detail: 'No candle data',
          f3: false, f3Detail: 'No candle data',
          f4: false, f4Detail: 'No candle data',
          f5: false, f5Detail: 'No candle data',
          passedAll: false,
        });
        continue;
      }

      const latest = candles[candles.length - 1];
      const closePrice = latest.closePrice.toNumber();

      let high52w = -Infinity;
      let low52w = Infinity;
      for (const c of candles) {
        const h = c.highPrice.toNumber();
        const l = c.lowPrice.toNumber();
        if (h > high52w) high52w = h;
        if (l < low52w) low52w = l;
      }

      const ma200Slice = candles.slice(-200);
      const ma200 = ma200Slice.length >= 200
        ? ma200Slice.reduce((sum, c) => sum + c.closePrice.toNumber(), 0) / 200
        : null;

      const ma200_20dSlice = candles.length >= 220
        ? candles.slice(-(200 + 20), -20)
        : [];
      const ma200_20d = ma200_20dSlice.length >= 200
        ? ma200_20dSlice.reduce((sum, c) => sum + c.closePrice.toNumber(), 0) / 200
        : null;

      const stockIdxCode = stockIndexMap?.get(stockCode) || indexCode;
      const stockIdxCandles = indexCandlesMap.get(stockIdxCode) || [];
      const idxCloseNow = stockIdxCandles.length > 0
        ? stockIdxCandles[stockIdxCandles.length - 1].closePrice.toNumber()
        : 0;
      const idx63Ago = stockIdxCandles.length > 63
        ? stockIdxCandles[stockIdxCandles.length - 64].closePrice.toNumber()
        : null;
      const close63Ago = candles.length > 63
        ? candles[candles.length - 64].closePrice.toNumber()
        : null;

      let rsRaw = 0;
      if (close63Ago && close63Ago > 0 && idx63Ago && idx63Ago > 0) {
        const stockReturn = closePrice / close63Ago;
        const indexReturn = idxCloseNow / idx63Ago;
        rsRaw = stockReturn / indexReturn;
      }

      const tradingValue = latest.tradingValue
        ? Number(latest.tradingValue)
        : closePrice * Number(latest.volume);

      const f1 = closePrice >= low52w * 1.3;
      const f2 = closePrice >= 0.75 * high52w;
      const f3 = ma200 !== null && ma200_20d !== null && ma200 > ma200_20d;
      const f4 = rsRaw > 0;
      const f5 = tradingValue >= MIN_TRADING_VALUE;

      results.push({
        stockCode,
        hasData: true,
        candleCount: candles.length,
        closePrice,
        low52w,
        high52w,
        ma200,
        ma200_20d,
        rsRaw,
        tradingValue,
        f1, f1Detail: `price(${closePrice}) >= low52w*1.3(${(low52w * 1.3).toFixed(0)})`,
        f2, f2Detail: `price(${closePrice}) >= 75%*high52w(${(high52w * 0.75).toFixed(0)})`,
        f3, f3Detail: `MA200(${ma200?.toFixed(0) ?? 'null'}) > MA200_20d(${ma200_20d?.toFixed(0) ?? 'null'}) candles:${candles.length}`,
        f4, f4Detail: `RS(${rsRaw.toFixed(4)}) > 0, close63Ago:${close63Ago}, idx63Ago:${idx63Ago}`,
        f5, f5Detail: `거래대금(${(tradingValue / 1e8).toFixed(1)}억) >= 10억`,
        passedAll: f1 && f2 && f3 && f4 && f5,
      });
    }

    return {
      date: targetDate.toISOString().split('T')[0],
      totalChecked: stockCodes.length,
      passed: results.filter(r => r.passedAll).length,
      failed: results.filter(r => !r.passedAll).length,
      noData: results.filter(r => !r.hasData).length,
      results,
    };
  }

  /**
   * 상위 퍼센트 → 1~99 점수 변환
   *
   * 기준:
   *   상위 1%  → 99점
   *   상위 5%  → 95점
   *   상위 10% → 90점
   *   상위 30% → 70점
   *   상위 100% → 1점
   */
  private percentileToScore(topPercent: number): number {
    let score: number;

    if (topPercent <= 1) {
      score = 99;
    } else if (topPercent <= 5) {
      score = 99 - (topPercent - 1) * (4 / 4); // 99 → 95
    } else if (topPercent <= 10) {
      score = 95 - (topPercent - 5) * (5 / 5); // 95 → 90
    } else if (topPercent <= 30) {
      score = 90 - (topPercent - 10) * (20 / 20); // 90 → 70
    } else {
      score = 70 - (topPercent - 30) * (69 / 70); // 70 → 1
    }

    return Math.max(1, Math.min(99, Math.round(score)));
  }
}
