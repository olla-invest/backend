import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RealTimeChartService } from './real-time-chart.service';

@Injectable()
export class DataSchedulerService {
  private readonly logger = new Logger(DataSchedulerService.name);
  private isMetricsCalculating = false;

  constructor(private readonly realTimeChartService: RealTimeChartService) {}

  /**
   * 장중 3분마다 랭킹 재계산
   * 월~금 09:00 ~ 15:30
   */
  @Cron('*/3 9-15 * * 1-5', {
    timeZone: 'Asia/Seoul',
  })
  async recalculateMetricsDuringMarket() {
    // 15:30 이후 실행 방지 (KST 기준 명시적 계산)
    const now = new Date();
    const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const kstHours = kstNow.getUTCHours();
    const kstMinutes = kstNow.getUTCMinutes();
    if (kstHours === 15 && kstMinutes > 30) return;

    // 중복 실행 방지 (이전 계산이 아직 진행 중이면 스킵)
    if (this.isMetricsCalculating) {
      this.logger.warn('Metrics calculation already in progress, skipping');
      return;
    }

    this.isMetricsCalculating = true;
    this.logger.log('[장중] Recalculating metrics...');

    try {
      await this.realTimeChartService.calculateDailyMetrics('all');
      this.logger.log('[장중] Metrics recalculation completed');
    } catch (error) {
      this.logger.error('[장중] Metrics recalculation failed', error);
    } finally {
      this.isMetricsCalculating = false;
    }
  }

  /**
   * 매일 장 마감 후 종가 데이터 수집 및 랭킹 계산
   * 월~금 15:40 (장 마감 10분 후)
   */
  @Cron('40 15 * * 1-5', {
    timeZone: 'Asia/Seoul',
  })
  async collectEndOfDayData() {
    this.logger.log('=== Starting End-of-Day Data Collection ===');

    try {
      // 1. 당일 종가 캔들 데이터 수집 (KOSPI + KOSDAQ, 1일치)
      this.logger.log('Collecting day candles for KOSPI...');
      await this.realTimeChartService.collectAllDayCandles('0', 1);

      this.logger.log('Collecting day candles for KOSDAQ...');
      await this.realTimeChartService.collectAllDayCandles('10', 1);

      // 2. 데이터 초기화 및 메트릭 계산 (RS 점수, 랭킹 등)
      this.logger.log('Calculating stock metrics and rankings...');
      await this.realTimeChartService.initializeData();

      this.logger.log('=== End-of-Day Data Collection Completed Successfully ===');
    } catch (error) {
      this.logger.error('End-of-Day Data Collection failed', error);
    }
  }

  /**
   * 매일 장 시작 전 데이터 준비
   * 월~금 08:50 (장 시작 10분 전)
   */
  @Cron('50 8 * * 1-5', {
    timeZone: 'Asia/Seoul',
  })
  async prepareMarketOpenData() {
    this.logger.log('=== Preparing data for market open ===');

    try {
      // 전날 데이터가 최신인지 확인
      this.logger.log('Verifying data is up to date...');
      await this.realTimeChartService.initializeData();

      // 실시간 데이터 소스 연결 확인
      this.logger.log('Ensuring realtime connection...');
      await this.realTimeChartService.ensureRealtimeConnection();

      this.logger.log('=== Market Open Preparation Completed ===');
    } catch (error) {
      this.logger.error('Market Open Preparation failed', error);
    }
  }

  /**
   * 매일 자정 데이터 정리 및 유지보수
   * 매일 00:10
   */
  @Cron('10 0 * * *', {
    timeZone: 'Asia/Seoul',
  })
  async dailyMaintenance() {
    this.logger.log('=== Starting Daily Maintenance ===');

    try {
      // 오래된 캔들 데이터 정리 (예: 1년 이상 된 분봉 데이터)
      this.logger.log('Performing daily maintenance tasks...');
      // TODO: 필요시 오래된 데이터 정리 로직 추가

      this.logger.log('=== Daily Maintenance Completed ===');
    } catch (error) {
      this.logger.error('Daily Maintenance failed', error);
    }
  }
}
