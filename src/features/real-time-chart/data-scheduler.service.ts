import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RealTimeChartService } from './real-time-chart.service';
import { ChartStorageService } from './chart-storage.service';
import { RedisLockService } from '../../common/redis/redis-lock.service';
import { CronRunLogService } from '../../common/cron/cron-run-log.service';
import { isKrxTradingDay, previousTradingDay } from '../../common/utils/market-calendar.util';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * 스케줄 잡 정리
 *
 *  08:50 (월~금, 거래일)             prepareMarketOpenData
 *  09:00~15:30 (3분 / 30초)         실시간 연결 유지 / heartbeat
 *  15:40 (월~금, 거래일)             collectEndOfDayData   (원주가+수정주가 수집 후 메트릭스 계산)
 *  23:30 (매일, 거래일)              dailyAdjustedPriceBackfill (★ 메트릭스 계산 전에 실행)
 *  00:10 (매일)                     dailyMaintenance
 *  서버 시작 시                      onApplicationBootstrap → 누락된 메트릭스 catch-up
 *
 * 변경 핵심
 *  1) backfill 을 00:30 → 23:30 으로 옮겨 메트릭스 계산이 항상 최신 수정주가 위에서 돌도록 함.
 *  2) 한국 증시 휴장일에는 시장 관련 잡 전부 스킵.
 *  3) 메트릭스 잡은 Redis 분산락 + CronRunLog 로 보호되어 재시도/캐치업 가능.
 *  4) 메트릭스 종료 시 rsScore 로그파일을 항상 생성한다 (writeLogFile=true).
 *  5) 서버 재시작 시 직전 5거래일 누락 catch-up + 오늘 분 미집계이면 자동 집계.
 */
@Injectable()
export class DataSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DataSchedulerService.name);

  private static readonly LOCK_TTL_MS = 30 * 60 * 1000; // 30분 — 메트릭스 잡 최대 실행 추정치

  constructor(
    private readonly realTimeChartService: RealTimeChartService,
    private readonly chartStorage: ChartStorageService,
    private readonly redisLock: RedisLockService,
    private readonly cronRunLog: CronRunLogService,
    private readonly prisma: PrismaService,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // 장중 실시간 연결 유지
  // ─────────────────────────────────────────────────────────────

  /**
   * 장중 실시간 연결 유지 (랭킹 재계산 제거 — 메트릭스는 자정 00:05에만 갱신)
   * 월~금 09:00 ~ 15:30, 3분마다
   */
  @Cron('*/3 9-15 * * 1-5', { timeZone: 'Asia/Seoul' })
  async recalculateMetricsDuringMarket() {
    if (!isKrxTradingDay(new Date())) return;
    const { kstHours, kstMinutes } = this.getKstParts();
    if (kstHours === 15 && kstMinutes > 30) return;

    await this.realTimeChartService.ensureRealtimeConnection().catch((e) => {
      this.logger.warn(`[장중] Realtime reconnect failed: ${e.message}`);
    });
  }

  /**
   * 30초마다 실시간 연결 상태 확인 (장중 09:00~15:30)
   */
  @Cron('*/30 * * * * *', { timeZone: 'Asia/Seoul' })
  async checkRealtimeConnection() {
    if (!isKrxTradingDay(new Date())) return;
    const { kstHours, kstMinutes } = this.getKstParts();
    if (kstHours < 9 || kstHours > 15 || (kstHours === 15 && kstMinutes > 30)) return;

    const status = this.realTimeChartService.getRealtimeStatus();
    this.logger.log(`[heartbeat] realtime=${status.websocket.status} subscriptions=${status.subscriptions.total}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 장 시작 전 / 장 마감 후
  // ─────────────────────────────────────────────────────────────

  /**
   * 매일 장 시작 전 실시간 연결 준비. 월~금 08:50.
   */
  @Cron('50 8 * * 1-5', { timeZone: 'Asia/Seoul' })
  async prepareMarketOpenData() {
    if (!isKrxTradingDay(new Date())) {
      this.logger.log('[08:50] non-trading day, skip prepareMarketOpenData');
      return;
    }
    this.logger.log('=== Preparing realtime connection for market open ===');
    try {
      await this.realTimeChartService.ensureRealtimeConnection();
      this.logger.log('=== Market Open Preparation Completed ===');
    } catch (error) {
      this.logger.error('Market Open Preparation failed', error);
    }
  }

  /**
   * 장 마감 후 종가 일봉 수집. 월~금 15:40.
   * 윈도 10일 (원주가+수정주가 동시 수집).
   */
  @Cron('40 15 * * 1-5', { timeZone: 'Asia/Seoul' })
  async collectEndOfDayData() {
    if (!isKrxTradingDay(new Date())) {
      this.logger.log('[15:40] non-trading day, skip collectEndOfDayData');
      return;
    }
    this.logger.log('=== Starting End-of-Day Data Collection (10d, raw+adj) ===');

    const tradeDate = this.todayKstDateOnly();
    await this.cronRunLog.run('collectEndOfDayData', tradeDate, async () => {
      this.logger.log('Syncing trading states (거래정지 여부)...');
      await this.realTimeChartService.syncTradingStates().catch((e) =>
        this.logger.warn(`syncTradingStates failed: ${(e as Error).message}`),
      );
      this.logger.log('Collecting market index candles for KOSPI/KOSDAQ...');
      await this.realTimeChartService.collectIndexCandles();
      this.logger.log('Collecting day candles for KOSPI...');
      const kospi = await this.realTimeChartService.collectAllDayCandles('0', 10);
      this.logger.log('Collecting day candles for KOSDAQ...');
      const kosdaq = await this.realTimeChartService.collectAllDayCandles('10', 10);
      this.logger.log(
        `=== EOD Done — KOSPI ${kospi.success}/${kospi.total}, KOSDAQ ${kosdaq.success}/${kosdaq.total} ===`,
      );
      const lockKey = 'cron:lock:metrics-after-close';
      const result = await this.redisLock.withLock(lockKey, DataSchedulerService.LOCK_TTL_MS, async () => {
        await this.runCatchUp();
        await this.runMetricsFor(tradeDate);
      });

      if (result === null) {
        this.logger.warn('[15:40] Metrics calc skipped - another instance holds the lock.');
      }
    }).catch((err) => this.logger.error('End-of-Day Data Collection failed', err));
  }

  // ─────────────────────────────────────────────────────────────
  // 자정 전 수정주가 backfill (★ 순서 핵심)
  // ─────────────────────────────────────────────────────────────

  /**
   * 매일 23:30 — 최근 90일 일봉 재수집 (수정주가 이벤트 반영)
   * 메트릭스 계산(00:05)보다 35분 먼저 실행되어 RS·필터가 항상 최신 수정주가 위에서 계산되도록 함.
   */
  @Cron('30 23 * * *', { timeZone: 'Asia/Seoul' })
  async dailyAdjustedPriceBackfill() {
    if (!isKrxTradingDay(new Date())) {
      this.logger.log('[23:30] non-trading day, skip dailyAdjustedPriceBackfill');
      return;
    }
    this.logger.log('=== Starting Daily Adjusted Price Backfill (90 days) ===');

    const tradeDate = this.todayKstDateOnly();
    await this.cronRunLog.run('dailyAdjustedPriceBackfill', tradeDate, async () => {
      this.logger.log('Backfilling market index candles for KOSPI/KOSDAQ...');
      await this.realTimeChartService.collectIndexCandles();
      await this.realTimeChartService.backfillDayCandles('0', 90);
      await this.realTimeChartService.backfillDayCandles('10', 90);
      this.logger.log('=== Daily Adjusted Price Backfill Completed ===');
    }).catch((err) => this.logger.error('Daily adjusted price backfill failed', err));
  }

  // ─────────────────────────────────────────────────────────────
  // 자정 메트릭스 계산
  // ─────────────────────────────────────────────────────────────

  /**
   * 서버 시작 시 — 직전 5거래일 누락 catch-up + 장 마감 후이면 오늘 분 미집계 시 자동 집계.
   * - 이미 SUCCESS 기록이 있으면 cronRunLog.run()이 자동 skip.
   * - Redis 분산락으로 중복 실행 방지.
   */
  async onApplicationBootstrap() {
    this.logger.log('[bootstrap] Checking for missed metrics...');
    await this.runMetricsSafetyNet();
  }

  private async runMetricsSafetyNet() {
    const lockKey = 'cron:lock:metrics-midnight';
    const result = await this.redisLock.withLock(lockKey, DataSchedulerService.LOCK_TTL_MS, async () => {
      await this.runCatchUp();
      const targetDate = this.metricsTargetTradeDate();
      const iso = targetDate.toISOString().slice(0, 10);
      if (await this.hasMetricsForDate(targetDate)) {
        this.logger.log(`[safety-net] metrics already exist for ${iso}`);
        return;
      }
      if (!(await this.hasRequiredCandlesForDate(targetDate))) {
        this.logger.warn(`[safety-net] candles/index not ready for ${iso}; skip metrics recovery`);
        return;
      }
      await this.runMetricsFor(targetDate, true);
    });

    if (result === null) {
      this.logger.warn('Metrics safety-net skipped — another instance holds the lock.');
    }
  }

  // Metrics are calculated from collectEndOfDayData at 15:40 after EOD candle collection.
  // Fallback: onApplicationBootstrap covers missed runs on server restart.
  async calculateMetricsAtMidnight() {
    await this.runMetricsSafetyNet();
  }

  @Cron('*/30 16-23 * * 1-5', { timeZone: 'Asia/Seoul' })
  async recoverMissedAfterCloseMetrics() {
    if (!isKrxTradingDay(new Date())) return;
    await this.runMetricsSafetyNet();
  }

  /**
   * 매일 00:10 — 일일 유지보수.
   * [Patch 2] 잔존 비거래일(주말/한국공휴일) 일봉 캔들 정리
   * [Patch 5] 거래정지 빈값 캔들을 직전 정상 거래일 종가로 백필
   */
  @Cron('10 0 * * *', { timeZone: 'Asia/Seoul' })
  async dailyMaintenance() {
    this.logger.log('=== Starting Daily Maintenance ===');
    try {
      const deleted = await this.chartStorage.cleanupNonTradingDayCandles();
      if (deleted > 0) {
        this.logger.warn(`[유지보수] Removed ${deleted} residual non-trading-day candles`);
      }
      const filled = await this.chartStorage.backfillSuspendedDayCandles();
      if (filled > 0) {
        this.logger.warn(`[유지보수] Backfilled ${filled} suspended-day candles with prior close`);
      }
      this.logger.log('=== Daily Maintenance Completed ===');
    } catch (error) {
      this.logger.error('Daily Maintenance failed', error);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 내부 헬퍼
  // ─────────────────────────────────────────────────────────────

  /**
   * 메트릭스 계산이 대상으로 삼아야 할 거래일.
   * 00:05 KST 호출이면 = "전 거래일" (휴장일 건너뜀)
   */
  private metricsTargetTradeDate(now: Date = new Date()): Date {
    const { kstHours, kstMinutes } = this.getKstParts(now);
    const isAfterClose = kstHours > 15 || (kstHours === 15 && kstMinutes >= 30);
    if (isAfterClose && isKrxTradingDay(now)) {
      // 장 마감 후이고 오늘이 거래일이면 오늘 기준
      return this.todayKstDateOnly(now);
    }
    return this.dateOnly(previousTradingDay(now));
  }

  /**
   * 직전 5거래일 중 SUCCESS 가 아닌 (또는 기록 자체가 없는) trade_date 를 채워넣기.
   * 단순히 빠진 거래일이 있는지 점검하고, 누락된 거래일에 한해 다시 계산.
   */
  private async runCatchUp(): Promise<void> {
    const today = this.todayKstDateOnly();
    const candidateDates: Date[] = [];
    const cursor = new Date(today);
    for (let i = 0; i < 6 && candidateDates.length < 5; i++) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      if (isKrxTradingDay(cursor)) {
        candidateDates.push(new Date(cursor));
      }
    }

    const failed = await this.cronRunLog.findUnfinishedDates('calculateMetricsAfterClose', 7);
    const failedSet = new Set(failed.map((d) => d.toISOString().slice(0, 10)));

    for (const d of candidateDates) {
      const iso = d.toISOString().slice(0, 10);
      const metricsMissing = !(await this.hasMetricsForDate(d));
      if (!failedSet.has(iso) && !metricsMissing) continue;
      this.logger.warn(`[catch-up] Re-running metrics for ${iso}`);
      try {
        await this.runMetricsFor(d, metricsMissing);
      } catch (err) {
        this.logger.error(`[catch-up] Failed for ${iso}`, err);
      }
    }
  }

  /**
   * 특정 거래일에 대해 메트릭스 계산 1회 실행. CronRunLog 에 기록.
   * writeLogFile=true 로 rsScore 로그파일도 함께 생성.
   */
  private async runMetricsFor(tradeDate: Date, force = false): Promise<void> {
    const iso = tradeDate.toISOString().slice(0, 10);
    if (force) {
      await this.resetMetricsRunLog(tradeDate);
    }
    this.logger.log(`=== [메트릭스] Starting calculation for ${iso} ===`);

    await this.cronRunLog.run(
      'calculateMetricsAfterClose',
      tradeDate,
      async () => {
        const tradeDateStr = iso.replace(/-/g, ''); // YYYYMMDD
        // writeLogFile=true → logs/rs-scores-*.log 자동 생성
        const result = await this.realTimeChartService.calculateDailyMetrics('all', tradeDateStr, true);
        if (!result?.success || !result.count) {
          throw new Error(`metrics calculation returned empty/failed result: ${JSON.stringify(result)}`);
        }
        this.logger.log(`=== [메트릭스] Calculation Completed for ${iso} ===`);
        return result;
      },
      { metadata: { tradeDate: iso } },
    ).catch((err) => {
      this.logger.error(`[메트릭스] Calculation failed for ${iso}`, err);
      throw err;
    });
  }

  private async hasMetricsForDate(tradeDate: Date): Promise<boolean> {
    const rows = await this.prisma.$queryRawUnsafe<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count FROM stock_daily_metrics WHERE trade_date = $1`,
      this.dateOnly(tradeDate),
    );
    return (rows[0]?.count ?? 0) > 0;
  }

  private async hasRequiredCandlesForDate(tradeDate: Date): Promise<boolean> {
    const rows = await this.prisma.$queryRawUnsafe<{ stock_count: number; index_count: number }[]>(
      `SELECT
         COUNT(*) FILTER (WHERE stock_code NOT LIKE 'INDEX_%')::int AS stock_count,
         COUNT(*) FILTER (WHERE stock_code IN ('INDEX_KOSPI', 'INDEX_KOSDAQ'))::int AS index_count
       FROM stock_candles
       WHERE candle_type = 'day'
         AND candle_time::date = $1`,
      this.dateOnly(tradeDate),
    );
    const row = rows[0];
    return (row?.stock_count ?? 0) > 0 && (row?.index_count ?? 0) >= 2;
  }

  private async resetMetricsRunLog(tradeDate: Date): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE cron_run_log
          SET status = 'FAILED',
              error_msg = 'reset because stock_daily_metrics is missing',
              finished_at = NOW()
        WHERE job_name = 'calculateMetricsAfterClose'
          AND trade_date = $1
          AND status = 'SUCCESS'`,
      this.dateOnly(tradeDate),
    );
  }

  private getKstParts(now: Date = new Date()): { kstHours: number; kstMinutes: number } {
    const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    return { kstHours: kstNow.getUTCHours(), kstMinutes: kstNow.getUTCMinutes() };
  }

  /** 오늘 KST 자정 (UTC 정규화된 DATE) */
  private todayKstDateOnly(now: Date = new Date()): Date {
    const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const dateStr = kstNow.toISOString().split('T')[0];
    return new Date(`${dateStr}T00:00:00.000Z`);
  }

  private dateOnly(d: Date): Date {
    const out = new Date(d);
    out.setUTCHours(0, 0, 0, 0);
    return out;
  }
}
