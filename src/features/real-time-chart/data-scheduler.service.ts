import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RealTimeChartService } from './real-time-chart.service';

@Injectable()
export class DataSchedulerService {
  private readonly logger = new Logger(DataSchedulerService.name);

  constructor(private readonly realTimeChartService: RealTimeChartService) {}

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
      // 1. 당일 종가 캔들 데이터 수집
      this.logger.log('Collecting day candles for all stocks...');
      await this.realTimeChartService.collectDayCandles();

      // 2. 메트릭 계산 (RS 점수, 랭킹 등)
      this.logger.log('Calculating stock metrics...');
      await this.realTimeChartService.calculateStockMetrics();

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
