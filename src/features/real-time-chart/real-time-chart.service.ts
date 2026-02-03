import { Injectable, Logger } from '@nestjs/common';
import { KiwoomRestService } from '../../integrations/kiwoom/rest/kiwoom-rest.service';
import { KiwoomWebSocketService } from '../../integrations/kiwoom/websocket/kiwoom-websocket.service';
import { ChartStorageService } from './chart-storage.service';

@Injectable()
export class RealTimeChartService {
  private readonly logger = new Logger(RealTimeChartService.name);

  constructor(
    private readonly kiwoomRest: KiwoomRestService,
    private readonly kiwoomWebSocket: KiwoomWebSocketService,
    private readonly chartStorage: ChartStorageService,
  ) {}

  /**
   * 분봉 차트 데이터 조회 (과거 데이터)
   */
  async getMinuteCandles(stockCode: string, interval: '1' | '3' | '5' | '10' | '15' | '30' | '45' | '60') {
    this.logger.log(`Getting ${interval}min candles for ${stockCode}`);

    // 1. 키움 API에서 데이터 조회
    const kiwoomData = await this.kiwoomRest.getMinuteCandles(stockCode, interval);

    // 2. DB에 저장
    const candles = kiwoomData.stk_min_pole_chart_qry.map((item) => ({
      stockCode,
      candleType: `${interval}min`,
      candleTime: this.parseCandleTime(item.cntr_tm),
      openPrice: this.parsePrice(item.open_pric),
      highPrice: this.parsePrice(item.high_pric),
      lowPrice: this.parsePrice(item.low_pric),
      closePrice: this.parsePrice(item.cur_prc),
      volume: BigInt(item.trde_qty),
    }));

    // 병렬로 저장
    await Promise.all(candles.map((candle) => this.chartStorage.saveCandle(candle)));

    return {
      stockCode,
      interval: `${interval}min`,
      candles: candles.map((c) => ({
        time: c.candleTime.toISOString(),
        open: c.openPrice.toString(),
        high: c.highPrice.toString(),
        low: c.lowPrice.toString(),
        close: c.closePrice.toString(),
        volume: c.volume.toString(),
      })),
    };
  }

  /**
   * 틱 차트 데이터 조회
   */
  async getTickCandles(stockCode: string, interval: '1' | '3' | '5' | '10' | '30') {
    this.logger.log(`Getting ${interval}tick candles for ${stockCode}`);

    const kiwoomData = await this.kiwoomRest.getTickCandles(stockCode, interval);

    const candles = kiwoomData.stk_tic_chart_qry.map((item) => ({
      time: this.parseCandleTime(item.cntr_tm).toISOString(),
      open: this.parsePrice(item.open_pric).toString(),
      high: this.parsePrice(item.high_pric).toString(),
      low: this.parsePrice(item.low_pric).toString(),
      close: this.parsePrice(item.cur_prc).toString(),
      volume: item.trde_qty,
    }));

    return {
      stockCode,
      interval: `${interval}tick`,
      candles,
    };
  }

  /**
   * 일봉 차트 데이터 조회 및 저장
   */
  async getDayCandles(stockCode: string, baseDate: string, saveToDb = false, days = 7) {
    this.logger.log(`Getting day candles for ${stockCode} from ${baseDate}`);

    const kiwoomData = await this.kiwoomRest.getDayCandles(stockCode, baseDate);

    // 최근 N일만 필터링
    const recentCandles = kiwoomData.stk_dt_pole_chart_qry.slice(0, days);

    const candles = recentCandles.map((item) => ({
      date: item.dt,
      open: this.parsePrice(item.open_pric).toString(),
      high: this.parsePrice(item.high_pric).toString(),
      low: this.parsePrice(item.low_pric).toString(),
      close: this.parsePrice(item.cur_prc).toString(),
      volume: item.trde_qty,
      tradingValue: item.trde_prica,
    }));

    // DB에 저장
    if (saveToDb) {
      const candlesToSave = recentCandles.map((item) => ({
        stockCode,
        candleType: 'day',
        candleTime: this.parseDateOnly(item.dt),
        openPrice: this.parsePrice(item.open_pric),
        highPrice: this.parsePrice(item.high_pric),
        lowPrice: this.parsePrice(item.low_pric),
        closePrice: this.parsePrice(item.cur_prc),
        volume: BigInt(item.trde_qty),
        tradingValue: BigInt(item.trde_prica || '0'),
      }));

      await Promise.all(candlesToSave.map((c) => this.chartStorage.saveCandle(c)));
      this.logger.debug(`Saved ${candlesToSave.length} day candles for ${stockCode}`);
    }

    return {
      stockCode,
      candles,
    };
  }

  /**
   * 종목 리스트 조회 (프론트엔드 인터페이스에 맞춰서)
   */
  async getStockList(marketType: '0' | '10' | '8' = '0') {
    this.logger.log(`Getting stock list for market type: ${marketType}`);
    const result = await this.kiwoomRest.getStockList(marketType);

    // 6자리 숫자 종목코드만 필터
    const validStocks = result.list.filter((s) => s.code.match(/^\d{6}$/));

    return {
      marketType,
      count: validStocks.length,
      stocks: validStocks.map((s, index) => ({
        id: s.code,
        rank: index + 1,
        companyName: s.name,
        stockCode: s.code,
        currentPrice: 0, // 실시간 가격은 WebSocket으로 업데이트 예정
        exchange: s.marketName === '거래소' ? 'KOSPI' : s.marketName === '코스닥' ? 'KOSDAQ' : s.marketName,
        relativeStrengthScore: 0, // RS 점수 계산 로직 추가 예정
        isHighPrice: false, // 신고가 여부 판단 로직 추가 예정
        investmentIndicators: '-',
        investmentIndicatorsDtl: '-',
        theme: s.upName || '-',
        upName: s.upName || '-',
        rankChange3Days: [], // 순위 변동 추적 로직 추가 예정
      })),
    };
  }

  /**
   * 전체 종목 일봉 수집 (1주일치)
   */
  async collectAllDayCandles(marketType: '0' | '10' = '0', days = 7) {
    this.logger.log(`Starting bulk day candle collection for market: ${marketType}, days: ${days}`);

    const stockList = await this.kiwoomRest.getStockList(marketType);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    // 일반 주식만 필터 (6자리 숫자 종목코드, 거래소 종목)
    const stocks = stockList.list.filter(
      (s) => s.marketCode === marketType && s.code.match(/^\d{6}$/),
    );

    this.logger.log(`Found ${stocks.length} stocks to process`);

    let success = 0;
    let failed = 0;
    const errors: { code: string; error: string }[] = [];

    for (const stock of stocks) {
      try {
        await this.getDayCandles(stock.code, today, true, days);
        success++;

        // API 호출 제한을 위한 딜레이 (100ms)
        await new Promise((resolve) => setTimeout(resolve, 100));

        if (success % 100 === 0) {
          this.logger.log(`Progress: ${success}/${stocks.length} stocks processed`);
        }
      } catch (error) {
        failed++;
        errors.push({ code: stock.code, error: error.message });
        this.logger.warn(`Failed to fetch day candles for ${stock.code}: ${error.message}`);
      }
    }

    this.logger.log(`Bulk collection completed: ${success} success, ${failed} failed`);

    return {
      marketType,
      days,
      total: stocks.length,
      success,
      failed,
      errors: errors.slice(0, 10), // 최대 10개 에러만 반환
    };
  }

  /**
   * DB에서 저장된 캔들 데이터 조회
   */
  async getStoredCandles(
    stockCode: string,
    candleType: string,
    startDate: string,
    endDate: string,
  ) {
    const startTime = new Date(startDate);
    const endTime = new Date(endDate);

    const candles = await this.chartStorage.getCandles(stockCode, candleType, startTime, endTime);

    return {
      stockCode,
      candleType,
      candles: candles.map((c) => ({
        time: c.candleTime.toISOString(),
        open: c.openPrice.toString(),
        high: c.highPrice.toString(),
        low: c.lowPrice.toString(),
        close: c.closePrice.toString(),
        volume: c.volume.toString(),
      })),
    };
  }

  /**
   * 실시간 구독 시작
   */
  async startRealtime(stockCode: string) {
    this.logger.log(`Starting realtime subscription for ${stockCode}`);
    await this.kiwoomWebSocket.subscribe(stockCode, ['0B', '0D']);
    return { success: true, stockCode };
  }

  /**
   * 실시간 구독 중지
   */
  async stopRealtime(stockCode: string) {
    this.logger.log(`Stopping realtime subscription for ${stockCode}`);
    await this.kiwoomWebSocket.unsubscribe(stockCode);
    return { success: true, stockCode };
  }

  /**
   * 캔들 시간 파싱 (YYYYMMDDHHmmss)
   */
  private parseCandleTime(timeStr: string): Date {
    const year = parseInt(timeStr.substring(0, 4));
    const month = parseInt(timeStr.substring(4, 6)) - 1;
    const day = parseInt(timeStr.substring(6, 8));
    const hour = parseInt(timeStr.substring(8, 10));
    const minute = parseInt(timeStr.substring(10, 12));
    const second = parseInt(timeStr.substring(12, 14));

    return new Date(year, month, day, hour, minute, second);
  }

  /**
   * 가격 파싱 (부호 제거)
   */
  private parsePrice(priceStr: string): number {
    return parseFloat(priceStr.replace(/[+\-]/g, ''));
  }

  /**
   * 날짜만 파싱 (YYYYMMDD)
   */
  private parseDateOnly(dateStr: string): Date {
    const year = parseInt(dateStr.substring(0, 4));
    const month = parseInt(dateStr.substring(4, 6)) - 1;
    const day = parseInt(dateStr.substring(6, 8));
    return new Date(year, month, day);
  }
}
