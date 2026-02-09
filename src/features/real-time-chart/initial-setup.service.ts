import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { KiwoomRestService } from '../../integrations/kiwoom/rest/kiwoom-rest.service';
import { StockMetricsService } from './stock-metrics.service';
import { Prisma } from '../../../generated/prisma';

@Injectable()
export class InitialSetupService {
  private readonly logger = new Logger(InitialSetupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kiwoomRest: KiwoomRestService,
    private readonly metricsService: StockMetricsService,
  ) {}

  /**
   * 빠른 초기 설정 (최근 7일 데이터만 - 홈 화면 즉시 사용 가능)
   */
  async runQuickSetup(marketType: '0' | '10' | '8' = '0') {
    this.logger.log(`Starting QUICK setup for market type: ${marketType}`);

    try {
      // 1. 종목 리스트 가져오기
      await this.fetchAndSaveStockList(marketType);

      // 2. 최근 7일 일봉 데이터만 가져오기
      await this.fetchHistoricalCandles(marketType, 7);

      // 3. RS 지표 계산 (최근 7일)
      await this.calculateHistoricalMetrics(marketType, 7);

      this.logger.log('Quick setup completed successfully');

      return {
        success: true,
        message: 'Quick setup completed - 최근 7일 데이터 준비 완료',
        mode: 'quick',
      };
    } catch (error) {
      this.logger.error('Quick setup failed', error);
      throw error;
    }
  }

  /**
   * 전체 초기 설정 (1년치 데이터 - 백그라운드 배치용)
   */
  async runFullSetup(marketType: '0' | '10' | '8' = '0') {
    this.logger.log(`Starting FULL setup for market type: ${marketType}`);

    try {
      // 1. 종목 리스트 가져오기 (이미 있으면 스킵)
      await this.fetchAndSaveStockList(marketType);

      // 2. 전체 1년 일봉 데이터 가져오기
      await this.fetchHistoricalCandles(marketType, 365);

      // 3. RS 지표 계산 (최근 90일)
      await this.calculateHistoricalMetrics(marketType, 90);

      this.logger.log('Full setup completed successfully');

      return {
        success: true,
        message: 'Full setup completed - 1년치 데이터 준비 완료',
        mode: 'full',
      };
    } catch (error) {
      this.logger.error('Full setup failed', error);
      throw error;
    }
  }

  /**
   * 전체 초기 설정 실행 (기본 = 빠른 설정)
   */
  async runInitialSetup(marketType: '0' | '10' | '8' = '0') {
    return this.runQuickSetup(marketType);
  }

  /**
   * 확장 데이터 수집 (10년치 등 장기 데이터)
   */
  async runExtendedDataCollection(
    marketType: '0' | '10' | '8' = '0',
    days: number = 3650,
  ) {
    this.logger.log(
      `Starting EXTENDED data collection for market type: ${marketType}, days: ${days}`,
    );

    const startTime = Date.now();

    try {
      // 1. 종목 리스트 확인 (없으면 먼저 가져오기)
      let mappedMarketType: 'KOSPI' | 'KOSDAQ' | 'OTHER';
      if (marketType === '0') {
        mappedMarketType = 'KOSPI';
      } else if (marketType === '10') {
        mappedMarketType = 'KOSDAQ';
      } else {
        mappedMarketType = 'OTHER';
      }

      const stockCount = await this.prisma.company.count({
        where: {
          marketType: mappedMarketType,
          deletedAt: null,
        },
      });

      if (stockCount === 0) {
        this.logger.log('No stocks found, fetching stock list first...');
        await this.fetchAndSaveStockList(marketType);
      } else {
        this.logger.log(`Found ${stockCount} stocks in ${mappedMarketType}`);
      }

      // 2. 장기 일봉 데이터 수집 (forceUpdate = true)
      const result = await this.fetchHistoricalCandles(marketType, days, true);

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      this.logger.log(
        `Extended data collection completed in ${duration}s - Processed: ${result.processedCount}, Updated: ${result.updatedCount}, Skipped: ${result.skippedCount}`,
      );

      return {
        success: true,
        message: `${days}일치 데이터 수집 완료`,
        duration: `${duration}s`,
        stats: {
          processed: result.processedCount,
          updated: result.updatedCount,
          skipped: result.skippedCount,
        },
      };
    } catch (error) {
      this.logger.error('Extended data collection failed', error);
      throw error;
    }
  }

  /**
   * 1. 종목 리스트 가져와서 DB에 저장
   */
  private async fetchAndSaveStockList(marketType: '0' | '10' | '8') {
    this.logger.log(`Fetching stock list for market type: ${marketType}`);

    const response = await this.kiwoomRest.getStockList(marketType);
    const stocks = response.list;

    this.logger.log(`Fetched ${stocks.length} stocks`);

    let savedCount = 0;
    let skippedCount = 0;

    for (const stock of stocks) {
      // DB에 이미 있는지 확인
      const existing = await this.prisma.company.findFirst({
        where: {
          stockCode: stock.code,
          deletedAt: null,
        },
      });

      if (existing) {
        skippedCount++;
        continue;
      }

      // 시장 타입 매핑
      let mappedMarketType: 'KOSPI' | 'KOSDAQ' | 'OTHER';
      if (marketType === '0') {
        mappedMarketType = 'KOSPI';
      } else if (marketType === '10') {
        mappedMarketType = 'KOSDAQ';
      } else {
        mappedMarketType = 'OTHER';
      }

      // 새 종목 저장
      await this.prisma.company.create({
        data: {
          companyName: stock.name,
          stockCode: stock.code,
          marketType: mappedMarketType,
        },
      });

      savedCount++;
    }

    this.logger.log(
      `Stock list sync completed: ${savedCount} saved, ${skippedCount} skipped`,
    );

    return { savedCount, skippedCount };
  }

  /**
   * 2. 과거 일봉 데이터 가져오기
   */
  private async fetchHistoricalCandles(
    marketType: '0' | '10' | '8',
    days: number = 365,
    forceUpdate: boolean = false,
  ) {
    this.logger.log(`Fetching historical candle data (last ${days} days)`);

    // 지정된 일수만큼 이전 날짜 계산
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const baseDate = startDate.toISOString().split('T')[0].replace(/-/g, '');

    // 해당 시장의 모든 종목 조회
    let mappedMarketType: 'KOSPI' | 'KOSDAQ' | 'OTHER';
    if (marketType === '0') {
      mappedMarketType = 'KOSPI';
    } else if (marketType === '10') {
      mappedMarketType = 'KOSDAQ';
    } else {
      mappedMarketType = 'OTHER';
    }

    const companies = await this.prisma.company.findMany({
      where: {
        marketType: mappedMarketType,
        deletedAt: null,
      },
    });

    this.logger.log(`Processing ${companies.length} companies`);

    let processedCount = 0;
    let skippedCount = 0;
    let updatedCount = 0;

    for (const company of companies) {
      try {
        // DB에 이미 일봉 데이터가 있는지 확인
        const existingCandles = await this.prisma.stockCandle.count({
          where: {
            stockCode: company.stockCode,
            candleType: 'day',
          },
        });

        // forceUpdate가 false이고 이미 데이터가 있으면 스킵
        if (!forceUpdate && existingCandles > 0) {
          this.logger.debug(
            `Skipping ${company.stockCode} - already has ${existingCandles} candles`,
          );
          skippedCount++;
          continue;
        }

        // 키움 API에서 일봉 데이터 가져오기
        const response = await this.kiwoomRest.getDayCandles(
          company.stockCode,
          baseDate,
        );

        if (response.return_code !== 0 || !response.stk_dt_pole_chart_qry) {
          this.logger.warn(
            `No candle data for ${company.stockCode}: ${response.return_msg}`,
          );
          continue;
        }

        let insertedCount = 0;

        // DB에 저장 (중복 체크)
        for (const candle of response.stk_dt_pole_chart_qry) {
          const candleTime = new Date(
            `${candle.dt.slice(0, 4)}-${candle.dt.slice(4, 6)}-${candle.dt.slice(6, 8)}`,
          );

          // 중복 체크 (이미 해당 날짜 데이터가 있는지)
          const existing = await this.prisma.stockCandle.findFirst({
            where: {
              stockCode: company.stockCode,
              candleType: 'day',
              candleTime,
            },
          });

          if (existing) {
            continue; // 이미 있는 데이터는 스킵
          }

          await this.prisma.stockCandle.create({
            data: {
              stockCode: company.stockCode,
              candleType: 'day',
              candleTime,
              openPrice: new Prisma.Decimal(candle.open_pric),
              highPrice: new Prisma.Decimal(candle.high_pric),
              lowPrice: new Prisma.Decimal(candle.low_pric),
              closePrice: new Prisma.Decimal(candle.cur_prc),
              volume: BigInt(candle.trde_qty),
              tradingValue: candle.trde_prica ? BigInt(candle.trde_prica) : null,
              prevDayCompare: new Prisma.Decimal(candle.pred_pre || 0),
            },
          });

          insertedCount++;
        }

        if (insertedCount > 0) {
          updatedCount++;
          this.logger.log(
            `${company.stockCode}: inserted ${insertedCount} new candles`,
          );
        }

        processedCount++;

        if (processedCount % 10 === 0) {
          this.logger.log(
            `Progress: ${processedCount}/${companies.length} (updated: ${updatedCount}, skipped: ${skippedCount})`,
          );
        }

        // API 호출 제한 고려 (100ms 대기)
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        this.logger.error(
          `Failed to fetch candles for ${company.stockCode}`,
          error,
        );
      }
    }

    this.logger.log(
      `Historical candles fetch completed: ${processedCount} processed, ${updatedCount} updated, ${skippedCount} skipped`,
    );

    return { processedCount, updatedCount, skippedCount };
  }

  /**
   * 3. 과거 RS 지표 계산
   */
  private async calculateHistoricalMetrics(marketType: '0' | '10' | '8', days: number = 90) {
    this.logger.log(`Calculating historical metrics (last ${days} days)`);

    // 지정된 일수만큼 거래일 찾기
    const recentDates = await this.prisma.stockCandle.findMany({
      where: {
        candleType: 'day',
      },
      select: {
        candleTime: true,
      },
      orderBy: {
        candleTime: 'desc',
      },
      take: days,
      distinct: ['candleTime'],
    });

    const uniqueDates = [
      ...new Set(
        recentDates.map((r) => r.candleTime.toISOString().split('T')[0]),
      ),
    ];

    this.logger.log(`Calculating metrics for ${uniqueDates.length} trading days`);

    let calculatedCount = 0;

    for (const dateStr of uniqueDates) {
      try {
        const tradeDate = new Date(dateStr);

        // 이미 계산된 날짜인지 확인
        const existingMetrics = await this.prisma.stockDailyMetrics.count({
          where: {
            tradeDate,
            marketType,
          },
        });

        if (existingMetrics > 0) {
          this.logger.debug(`Skipping ${dateStr} - already calculated`);
          continue;
        }

        // 지표 계산
        await this.metricsService.calculateAndSaveDailyMetrics(
          marketType,
          tradeDate,
        );

        calculatedCount++;

        this.logger.log(
          `Calculated metrics for ${dateStr} (${calculatedCount}/${uniqueDates.length})`,
        );

        // 과부하 방지를 위한 대기
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        this.logger.error(`Failed to calculate metrics for ${dateStr}`, error);
      }
    }

    this.logger.log(
      `Historical metrics calculation completed: ${calculatedCount} days processed`,
    );

    return { calculatedCount };
  }
}
