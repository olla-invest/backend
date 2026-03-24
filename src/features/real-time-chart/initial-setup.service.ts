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
  async runQuickSetup(marketType: '0' | '10' | 'all' = 'all') {
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
  async runFullSetup(marketType: '0' | '10' | 'all' = 'all') {
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
  async runInitialSetup(marketType: '0' | '10' | 'all' = 'all') {
    return this.runQuickSetup(marketType);
  }

  /**
   * 확장 데이터 수집 (10년치 등 장기 데이터)
   */
  async runExtendedDataCollection(
    marketType: '0' | '10' | 'all' = 'all',
    days: number = 3650,
  ) {
    this.logger.log(
      `Starting EXTENDED data collection for market type: ${marketType}, days: ${days}`,
    );

    const startTime = Date.now();

    try {
      // 1. 종목 리스트 동기화 (항상 실행 - 누락 종목 보완)
      this.logger.log('Syncing stock list...');
      await this.fetchAndSaveStockList(marketType);

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
  private async fetchAndSaveStockList(marketType: '0' | '10' | 'all') {
    this.logger.log(`Fetching stock list for market type: ${marketType}`);

    // 종목별 시장 타입을 보존하기 위해 시장별로 따로 가져옴
    let stocksWithMarket: Array<{ stock: any; mappedMarketType: 'KOSPI' | 'KOSDAQ' }>;
    if (marketType === 'all') {
      const [kospi, kosdaq] = await Promise.all([
        this.kiwoomRest.getStockList('0'),
        this.kiwoomRest.getStockList('10'),
      ]);
      stocksWithMarket = [
        ...kospi.list.map((s: any) => ({ stock: s, mappedMarketType: 'KOSPI' as const })),
        ...kosdaq.list.map((s: any) => ({ stock: s, mappedMarketType: 'KOSDAQ' as const })),
      ];
    } else {
      const response = await this.kiwoomRest.getStockList(marketType);
      const mapped = marketType === '0' ? 'KOSPI' as const : 'KOSDAQ' as const;
      stocksWithMarket = response.list.map((s: any) => ({ stock: s, mappedMarketType: mapped }));
    }
    this.logger.log(`Fetched ${stocksWithMarket.length} stocks`);

    let savedCount = 0;
    let skippedCount = 0;

    for (const { stock, mappedMarketType } of stocksWithMarket) {
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

      // 새 종목 저장 (각 종목의 실제 시장 타입 보존)
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
    marketType: '0' | '10' | 'all',
    days: number = 365,
    forceUpdate: boolean = false,
  ) {
    this.logger.log(`Fetching historical candle data (last ${days} days)`);

    // base_dt = 오늘 날짜 (키움 API는 base_dt부터 과거 방향으로 데이터 반환)
    const baseDate = new Date().toISOString().split('T')[0].replace(/-/g, '');

    // 해당 시장의 모든 종목 조회
    let companies: Awaited<ReturnType<typeof this.prisma.company.findMany>>;
    if (marketType === 'all') {
      companies = await this.prisma.company.findMany({
        where: {
          marketType: { in: ['KOSPI', 'KOSDAQ'] },
          deletedAt: null,
        },
      });
    } else {
      const mappedMarketType = marketType === '0' ? 'KOSPI' : 'KOSDAQ';
      companies = await this.prisma.company.findMany({
        where: {
          marketType: mappedMarketType,
          deletedAt: null,
        },
      });
    }

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

        // 키움 API에서 일봉 데이터 가져오기 (429 에러 시 재시도)
        let response: any;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            response = await this.kiwoomRest.getDayCandles(
              company.stockCode,
              baseDate,
            );
            break; // 성공 시 루프 탈출
          } catch (apiError: any) {
            if (apiError?.response?.status === 429 || apiError?.status === 429) {
              const waitTime = (attempt + 1) * 5000; // 5초, 10초, 15초
              this.logger.warn(
                `429 Rate limit for ${company.stockCode}, waiting ${waitTime / 1000}s (attempt ${attempt + 1}/3)`,
              );
              await new Promise((resolve) => setTimeout(resolve, waitTime));
            } else {
              throw apiError; // 429가 아닌 에러는 그대로 throw
            }
          }
        }

        if (!response || response.return_code !== 0 || !response.stk_dt_pole_chart_qry) {
          this.logger.warn(
            `No candle data for ${company.stockCode}: ${response?.return_msg || 'no response'}`,
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

          // 가격/거래량 안전 파싱 (부호 제거, 빈 문자열 처리)
          const safeDecimal = (v: any) => {
            const s = String(v ?? '0').replace(/[+\-,\s]/g, '').trim();
            return new Prisma.Decimal(s || '0');
          };
          const safeBigInt = (v: any) => {
            const cleaned = String(v ?? '0').replace(/[+\-,\s]/g, '').trim();
            const num = cleaned || '0';
            // 소수점이 있으면 정수 부분만 사용
            return BigInt(num.split('.')[0] || '0');
          };

          try {
            await this.prisma.stockCandle.create({
              data: {
                stockCode: company.stockCode,
                candleType: 'day',
                candleTime,
                openPrice: safeDecimal(candle.open_pric),
                highPrice: safeDecimal(candle.high_pric),
                lowPrice: safeDecimal(candle.low_pric),
                closePrice: safeDecimal(candle.cur_prc),
                volume: safeBigInt(candle.trde_qty),
                tradingValue: candle.trde_prica ? safeBigInt(candle.trde_prica) * 1_000_000n : null,
                prevDayCompare: safeDecimal(candle.pred_pre || '0'),
              },
            });

            insertedCount++;
          } catch (insertError) {
            this.logger.warn(
              `Failed to insert candle for ${company.stockCode} dt=${candle.dt}: ${insertError.message || insertError}`,
            );
          }
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

        // API 호출 제한 고려 (500ms 대기)
        await new Promise((resolve) => setTimeout(resolve, 500));
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
  private async calculateHistoricalMetrics(marketType: '0' | '10' | 'all', days: number = 90) {
    this.logger.log(`Calculating historical metrics (last ${days} days)`);

    // 지정된 일수만큼 거래일 찾기
    const recentDates = await this.prisma.stockCandle.findMany({
      where: {
        candleType: 'day',
        stockCode: { not: { startsWith: 'INDEX_' } },
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

    // KOSPI + KOSDAQ 종목 코드 + 종목별 지수 매핑 (통합 랭킹용)
    const [kospiCompanies, kosdaqCompanies] = await Promise.all([
      this.prisma.company.findMany({
        where: { marketType: 'KOSPI', deletedAt: null },
        select: { stockCode: true },
      }),
      this.prisma.company.findMany({
        where: { marketType: 'KOSDAQ', deletedAt: null },
        select: { stockCode: true },
      }),
    ]);

    const allStockCodes = [
      ...kospiCompanies.map((c) => c.stockCode),
      ...kosdaqCompanies.map((c) => c.stockCode),
    ];
    const stockIndexMap = new Map<string, string>();
    for (const c of kospiCompanies) stockIndexMap.set(c.stockCode, 'INDEX_KOSPI');
    for (const c of kosdaqCompanies) stockIndexMap.set(c.stockCode, 'INDEX_KOSDAQ');

    // 단일 시장만 요청된 경우 해당 시장 종목만 필터
    const targetStockCodes = marketType === 'all'
      ? allStockCodes
      : marketType === '0'
        ? kospiCompanies.map((c) => c.stockCode)
        : kosdaqCompanies.map((c) => c.stockCode);

    this.logger.log(`Stock codes loaded: KOSPI=${kospiCompanies.length}, KOSDAQ=${kosdaqCompanies.length}, target=${targetStockCodes.length}`);

    let calculatedCount = 0;

    for (const dateStr of uniqueDates) {
      try {
        const tradeDate = new Date(dateStr);

        // 이미 계산된 날짜인지 확인
        const existingMetrics = await this.prisma.stockDailyMetrics.count({
          where: {
            tradeDate,
            marketType: marketType === 'all' ? 'all' : marketType,
          },
        });

        if (existingMetrics > 0) {
          this.logger.debug(`Skipping ${dateStr} - already calculated`);
          continue;
        }

        // 통합 지표 계산 (KOSPI+KOSDAQ 합쳐서 랭킹, RS는 각 시장 지수 사용)
        await this.metricsService.calculateAndSaveDailyMetrics(
          marketType === 'all' ? 'all' : marketType,
          tradeDate,
          'INDEX_KOSPI',
          targetStockCodes,
          stockIndexMap,
        );

        calculatedCount++;

        if (calculatedCount % 10 === 0) {
          this.logger.log(
            `Progress: ${calculatedCount}/${uniqueDates.length} days processed`,
          );
        }

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
