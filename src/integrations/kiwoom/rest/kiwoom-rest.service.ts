import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { KiwoomAuthService } from '../auth/kiwoom-auth.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  KiwoomMinCandleResponse,
  KiwoomTickCandleResponse,
  KiwoomDayCandleData,
  KiwoomDayCandleResponse,
  KiwoomWeekCandleResponse,
  KiwoomMonthCandleResponse,
  KiwoomYearCandleResponse,
  KiwoomTodayPreviousExecutionResponse,
  KiwoomStockBasicInfoResponse,
  KiwoomStockListResponse,
  KiwoomSectorDayCandleResponse,
  KiwoomSectorCurrentPriceResponse,
  KiwoomMarketInvestorNetBuyResponse,
  KiwoomNewHighLowData,
  KiwoomNewHighLowResponse,
} from '../types/kiwoom.types';

@Injectable()
export class KiwoomRestService {
  private readonly logger = new Logger(KiwoomRestService.name);
  private readonly httpClient: AxiosInstance;
  private readonly apiUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: KiwoomAuthService,
    private readonly prisma: PrismaService,
  ) {
    const useMock = this.configService.get<boolean>('KIWOOM_USE_MOCK') === true;

    this.apiUrl = useMock
      ? this.configService.get<string>('KIWOOM_MOCK_API_URL')
      : this.configService.get<string>('KIWOOM_API_URL');

    this.httpClient = axios.create({
      baseURL: this.apiUrl,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
      },
      timeout: 30000,
    });
  }

  /**
   * 분봉 차트 데이터 조회
   */
  async getMinuteCandles(
    stockCode: string,
    interval: '1' | '3' | '5' | '10' | '15' | '30' | '45' | '60',
  ): Promise<KiwoomMinCandleResponse> {
    const startTime = Date.now();

    try {
      const token = await this.authService.ensureValidToken();

      this.logger.debug(`Fetching ${interval}min candles for ${stockCode}`);

      const response = await this.httpClient.post<KiwoomMinCandleResponse>(
        '/api/dostk/chart',
        {
          stk_cd: stockCode,
          tic_scope: interval,
          upd_stkpc_tp: '1',
        },
        {
          headers: {
            'api-id': 'ka10080',
            authorization: `Bearer ${token}`,
          },
        },
      );

      const responseTime = Date.now() - startTime;

      await this.logApiCall({
        apiName: 'ka10080',
        stockCode,
        requestData: { tic_scope: interval },
        responseStatus: 'SUCCESS',
        responseMessage: response.data.return_msg,
        responseTimeMs: responseTime,
      });

      return response.data;
    } catch (error) {
      const responseTime = Date.now() - startTime;

      await this.logApiCall({
        apiName: 'ka10080',
        stockCode,
        requestData: { tic_scope: interval },
        responseStatus: 'ERROR',
        responseMessage: error.message,
        responseTimeMs: responseTime,
      });

      this.logger.error(`Failed to fetch minute candles for ${stockCode}`, error);
      throw error;
    }
  }

  /**
   * 틱 차트 데이터 조회
   */
  async getTickCandles(
    stockCode: string,
    interval: '1' | '3' | '5' | '10' | '30',
  ): Promise<KiwoomTickCandleResponse> {
    const startTime = Date.now();

    try {
      const token = await this.authService.ensureValidToken();

      this.logger.debug(`Fetching ${interval}tick candles for ${stockCode}`);

      const response = await this.httpClient.post<KiwoomTickCandleResponse>(
        '/api/dostk/chart',
        {
          stk_cd: stockCode,
          tic_scope: interval,
          upd_stkpc_tp: '1',
        },
        {
          headers: {
            'api-id': 'ka10079',
            authorization: `Bearer ${token}`,
          },
        },
      );

      const responseTime = Date.now() - startTime;

      await this.logApiCall({
        apiName: 'ka10079',
        stockCode,
        requestData: { tic_scope: interval },
        responseStatus: 'SUCCESS',
        responseMessage: response.data.return_msg,
        responseTimeMs: responseTime,
      });

      return response.data;
    } catch (error) {
      const responseTime = Date.now() - startTime;

      await this.logApiCall({
        apiName: 'ka10079',
        stockCode,
        requestData: { tic_scope: interval },
        responseStatus: 'ERROR',
        responseMessage: error.message,
        responseTimeMs: responseTime,
      });

      this.logger.error(`Failed to fetch tick candles for ${stockCode}`, error);
      throw error;
    }
  }

  /**
   * 당일/전일 체결 데이터 조회 (ka10084)
   */
  async getTodayPreviousExecutions(
    stockCode: string,
    todayPrevious: '1' | '2',
    tickMinute: '0' | '1' = '1',
    time = '',
    retryOnAuthError = true,
  ): Promise<KiwoomTodayPreviousExecutionResponse> {
    const startTime = Date.now();

    try {
      const token = await this.authService.ensureValidToken();
      const requestData = {
        stk_cd: stockCode,
        tdy_pred: todayPrevious,
        tic_min: tickMinute,
        tm: time,
      };

      const response = await this.httpClient.post<KiwoomTodayPreviousExecutionResponse>(
        '/api/dostk/stkinfo',
        requestData,
        {
          headers: {
            'api-id': 'ka10084',
            authorization: `Bearer ${token}`,
          },
        },
      );

      const returnCode = response.data.return_code ?? response.data.returnCode;
      if (returnCode === 3 && retryOnAuthError) {
        this.logger.warn(`Token authentication failed for ka10084 ${stockCode}. Retrying...`);
        await this.authService.invalidateAllTokens();
        return this.getTodayPreviousExecutions(
          stockCode,
          todayPrevious,
          tickMinute,
          time,
          false,
        );
      }

      await this.logApiCall({
        apiName: 'ka10084-stkinfo',
        stockCode,
        requestData,
        responseStatus: 'SUCCESS',
        responseMessage: response.data.return_msg ?? response.data.returnMsg,
        responseTimeMs: Date.now() - startTime,
      });

      return response.data;
    } catch (error) {
      await this.logApiCall({
        apiName: 'ka10084-stkinfo',
        stockCode,
        requestData: { tdy_pred: todayPrevious, tic_min: tickMinute, tm: time },
        responseStatus: 'ERROR',
        responseMessage: error.message,
        responseTimeMs: Date.now() - startTime,
      });

      this.logger.error(`Failed to fetch today/previous executions for ${stockCode}`, error);
      throw error;
    }
  }

  /**
   * 종목기본정보 조회 (ka10001)
   */
  async getStockBasicInfo(
    stockCode: string,
    retryOnAuthError = true,
  ): Promise<KiwoomStockBasicInfoResponse> {
    const startTime = Date.now();

    try {
      const token = await this.authService.ensureValidToken();
      const requestData = { stk_cd: stockCode };

      const response = await this.httpClient.post<KiwoomStockBasicInfoResponse>(
        '/api/dostk/stkinfo',
        requestData,
        {
          headers: {
            'api-id': 'ka10001',
            authorization: `Bearer ${token}`,
          },
        },
      );

      const returnCode = response.data.return_code ?? response.data.returnCode;
      if (returnCode === 3 && retryOnAuthError) {
        this.logger.warn(`Token authentication failed for ka10001 ${stockCode}. Retrying...`);
        await this.authService.invalidateAllTokens();
        return this.getStockBasicInfo(stockCode, false);
      }

      await this.logApiCall({
        apiName: 'ka10001',
        stockCode,
        requestData,
        responseStatus: 'SUCCESS',
        responseMessage: response.data.return_msg ?? response.data.returnMsg,
        responseTimeMs: Date.now() - startTime,
      });

      return response.data;
    } catch (error) {
      await this.logApiCall({
        apiName: 'ka10001',
        stockCode,
        requestData: { stk_cd: stockCode },
        responseStatus: 'ERROR',
        responseMessage: error.message,
        responseTimeMs: Date.now() - startTime,
      });

      this.logger.error(`Failed to fetch stock basic info for ${stockCode}`, error);
      throw error;
    }
  }

  /**
   * 일봉 차트 데이터 조회
   */
  async getDayCandles(
    stockCode: string,
    baseDate: string,
  ): Promise<KiwoomDayCandleResponse> {
    const startTime = Date.now();

    try {
      const token = await this.authService.ensureValidToken();

      this.logger.debug(`Fetching day candles for ${stockCode} from ${baseDate}`);

      const response = await this.httpClient.post<KiwoomDayCandleResponse>(
        '/api/dostk/chart',
        {
          stk_cd: stockCode,
          base_dt: baseDate,
          upd_stkpc_tp: '1',
        },
        {
          headers: {
            'api-id': 'ka10081',
            authorization: `Bearer ${token}`,
          },
        },
      );

      const responseTime = Date.now() - startTime;

      await this.logApiCall({
        apiName: 'ka10081',
        stockCode,
        requestData: { base_dt: baseDate },
        responseStatus: 'SUCCESS',
        responseMessage: response.data.return_msg,
        responseTimeMs: responseTime,
      });

      return response.data;
    } catch (error) {
      const responseTime = Date.now() - startTime;

      await this.logApiCall({
        apiName: 'ka10081',
        stockCode,
        requestData: { base_dt: baseDate },
        responseStatus: 'ERROR',
        responseMessage: error.message,
        responseTimeMs: responseTime,
      });

      this.logger.error(`Failed to fetch day candles for ${stockCode}`, error);
      throw error;
    }
  }

  /**
   * 일봉 차트 연속조회 (종목상세용, ka10081)
   * maxCandles 기본값 750 ≈ 3년치
   */
  async getDayCandlesWithHistory(
    stockCode: string,
    baseDate: string,
    maxCandles = 750,
    adjustedPrice: '0' | '1' = '1',
  ): Promise<KiwoomDayCandleResponse> {
    const startTime = Date.now();
    const allCandles: KiwoomDayCandleData[] = [];
    let contYn = '';
    let nextKey = '';

    try {
      const token = await this.authService.ensureValidToken();

      do {
        const headers: Record<string, string> = {
          'api-id': 'ka10081',
          authorization: `Bearer ${token}`,
        };
        if (contYn === 'Y') {
          headers['cont-yn'] = contYn;
          headers['next-key'] = nextKey;
        }

        const response = await this.httpClient.post<KiwoomDayCandleResponse>(
          '/api/dostk/chart',
          { stk_cd: stockCode, base_dt: baseDate, upd_stkpc_tp: adjustedPrice },
          { headers },
        );

        allCandles.push(...response.data.stk_dt_pole_chart_qry);
        contYn = response.headers['cont-yn'] || '';
        nextKey = response.headers['next-key'] || '';

        this.logger.debug(`Day candles: ${allCandles.length}/${maxCandles}, cont: ${contYn}`);
      } while (contYn === 'Y' && allCandles.length < maxCandles);

      await this.logApiCall({
        apiName: 'ka10081',
        stockCode,
        requestData: { base_dt: baseDate },
        responseStatus: 'SUCCESS',
        responseMessage: `${allCandles.length} candles`,
        responseTimeMs: Date.now() - startTime,
      });

      return {
        stk_cd: stockCode,
        stk_dt_pole_chart_qry: allCandles.slice(0, maxCandles),
        return_code: 0,
        return_msg: '정상적으로 처리되었습니다',
      };
    } catch (error) {
      await this.logApiCall({
        apiName: 'ka10081',
        stockCode,
        requestData: { base_dt: baseDate },
        responseStatus: 'ERROR',
        responseMessage: error.message,
        responseTimeMs: Date.now() - startTime,
      });

      this.logger.error(`Failed to fetch day candles history for ${stockCode}`, error);
      throw error;
    }
  }

  /**
   * 주봉 차트 연속조회 (ka10082)
   * maxCandles 기본값 260 ≈ 5년치
   */
  async getWeekCandles(
    stockCode: string,
    baseDate: string,
    maxCandles = 260,
  ): Promise<KiwoomWeekCandleResponse> {
    const startTime = Date.now();
    const allCandles: KiwoomDayCandleData[] = [];
    let contYn = '';
    let nextKey = '';

    try {
      const token = await this.authService.ensureValidToken();

      do {
        const headers: Record<string, string> = {
          'api-id': 'ka10082',
          authorization: `Bearer ${token}`,
        };
        if (contYn === 'Y') {
          headers['cont-yn'] = contYn;
          headers['next-key'] = nextKey;
        }

        const response = await this.httpClient.post<KiwoomWeekCandleResponse>(
          '/api/dostk/chart',
          { stk_cd: stockCode, base_dt: baseDate, upd_stkpc_tp: '1' },
          { headers },
        );

        allCandles.push(...response.data.stk_stk_pole_chart_qry);
        contYn = response.headers['cont-yn'] || '';
        nextKey = response.headers['next-key'] || '';

        this.logger.debug(`Week candles: ${allCandles.length}/${maxCandles}, cont: ${contYn}`);
      } while (contYn === 'Y' && allCandles.length < maxCandles);

      await this.logApiCall({
        apiName: 'ka10082',
        stockCode,
        requestData: { base_dt: baseDate },
        responseStatus: 'SUCCESS',
        responseMessage: `${allCandles.length} candles`,
        responseTimeMs: Date.now() - startTime,
      });

      return {
        stk_cd: stockCode,
        stk_stk_pole_chart_qry: allCandles.slice(0, maxCandles),
        return_code: 0,
        return_msg: '정상적으로 처리되었습니다',
      };
    } catch (error) {
      await this.logApiCall({
        apiName: 'ka10082',
        stockCode,
        requestData: { base_dt: baseDate },
        responseStatus: 'ERROR',
        responseMessage: error.message,
        responseTimeMs: Date.now() - startTime,
      });

      this.logger.error(`Failed to fetch week candles for ${stockCode}`, error);
      throw error;
    }
  }

  /**
   * 월봉 차트 연속조회 (ka10083)
   * maxCandles 기본값 120 ≈ 10년치
   */
  async getMonthCandles(
    stockCode: string,
    baseDate: string,
    maxCandles = 120,
  ): Promise<KiwoomMonthCandleResponse> {
    const startTime = Date.now();
    const allCandles: KiwoomDayCandleData[] = [];
    let contYn = '';
    let nextKey = '';

    try {
      const token = await this.authService.ensureValidToken();

      do {
        const headers: Record<string, string> = {
          'api-id': 'ka10083',
          authorization: `Bearer ${token}`,
        };
        if (contYn === 'Y') {
          headers['cont-yn'] = contYn;
          headers['next-key'] = nextKey;
        }

        const response = await this.httpClient.post<KiwoomMonthCandleResponse>(
          '/api/dostk/chart',
          { stk_cd: stockCode, base_dt: baseDate, upd_stkpc_tp: '1' },
          { headers },
        );

        allCandles.push(...response.data.stk_mth_pole_chart_qry);
        contYn = response.headers['cont-yn'] || '';
        nextKey = response.headers['next-key'] || '';

        this.logger.debug(`Month candles: ${allCandles.length}/${maxCandles}, cont: ${contYn}`);
      } while (contYn === 'Y' && allCandles.length < maxCandles);

      await this.logApiCall({
        apiName: 'ka10083',
        stockCode,
        requestData: { base_dt: baseDate },
        responseStatus: 'SUCCESS',
        responseMessage: `${allCandles.length} candles`,
        responseTimeMs: Date.now() - startTime,
      });

      return {
        stk_cd: stockCode,
        stk_mth_pole_chart_qry: allCandles.slice(0, maxCandles),
        return_code: 0,
        return_msg: '정상적으로 처리되었습니다',
      };
    } catch (error) {
      await this.logApiCall({
        apiName: 'ka10083',
        stockCode,
        requestData: { base_dt: baseDate },
        responseStatus: 'ERROR',
        responseMessage: error.message,
        responseTimeMs: Date.now() - startTime,
      });

      this.logger.error(`Failed to fetch month candles for ${stockCode}`, error);
      throw error;
    }
  }

  /**
   * 연봉 차트 연속조회 (ka10084)
   * maxCandles 기본값 30 ≈ 30년치
   */
  async getYearCandles(
    stockCode: string,
    baseDate: string,
    maxCandles = 30,
  ): Promise<KiwoomYearCandleResponse> {
    const startTime = Date.now();
    const allCandles: KiwoomDayCandleData[] = [];
    let contYn = '';
    let nextKey = '';

    try {
      const token = await this.authService.ensureValidToken();

      do {
        const headers: Record<string, string> = {
          'api-id': 'ka10084',
          authorization: `Bearer ${token}`,
        };
        if (contYn === 'Y') {
          headers['cont-yn'] = contYn;
          headers['next-key'] = nextKey;
        }

        const response = await this.httpClient.post<KiwoomYearCandleResponse>(
          '/api/dostk/chart',
          { stk_cd: stockCode, base_dt: baseDate, upd_stkpc_tp: '1' },
          { headers },
        );

        allCandles.push(...response.data.stk_yr_pole_chart_qry);
        contYn = response.headers['cont-yn'] || '';
        nextKey = response.headers['next-key'] || '';

        this.logger.debug(`Year candles: ${allCandles.length}/${maxCandles}, cont: ${contYn}`);
      } while (contYn === 'Y' && allCandles.length < maxCandles);

      await this.logApiCall({
        apiName: 'ka10084',
        stockCode,
        requestData: { base_dt: baseDate },
        responseStatus: 'SUCCESS',
        responseMessage: `${allCandles.length} candles`,
        responseTimeMs: Date.now() - startTime,
      });

      return {
        stk_cd: stockCode,
        stk_yr_pole_chart_qry: allCandles.slice(0, maxCandles),
        return_code: 0,
        return_msg: '정상적으로 처리되었습니다',
      };
    } catch (error) {
      await this.logApiCall({
        apiName: 'ka10084',
        stockCode,
        requestData: { base_dt: baseDate },
        responseStatus: 'ERROR',
        responseMessage: error.message,
        responseTimeMs: Date.now() - startTime,
      });

      this.logger.error(`Failed to fetch year candles for ${stockCode}`, error);
      throw error;
    }
  }

  /**
   * 업종 일봉 차트 조회 (ka20006)
   * @param sectorCode 업종코드 (001: KOSPI, 101: KOSDAQ)
   * @param baseDate 기준일자 (YYYYMMDD)
   */
  async getSectorDayCandles(
    sectorCode: string,
    baseDate: string,
  ): Promise<KiwoomSectorDayCandleResponse> {
    const startTime = Date.now();

    try {
      const token = await this.authService.ensureValidToken();

      this.logger.debug(`Fetching sector day candles for ${sectorCode} from ${baseDate}`);

      const response = await this.httpClient.post<KiwoomSectorDayCandleResponse>(
        '/api/dostk/chart',
        {
          inds_cd: sectorCode,
          base_dt: baseDate,
        },
        {
          headers: {
            'api-id': 'ka20006',
            authorization: `Bearer ${token}`,
          },
        },
      );

      const responseTime = Date.now() - startTime;

      await this.logApiCall({
        apiName: 'ka20006',
        stockCode: sectorCode,
        requestData: { inds_cd: sectorCode, base_dt: baseDate },
        responseStatus: 'SUCCESS',
        responseMessage: response.data.return_msg,
        responseTimeMs: responseTime,
      });

      return response.data;
    } catch (error) {
      const responseTime = Date.now() - startTime;

      await this.logApiCall({
        apiName: 'ka20006',
        stockCode: sectorCode,
        requestData: { inds_cd: sectorCode, base_dt: baseDate },
        responseStatus: 'ERROR',
        responseMessage: error.message,
        responseTimeMs: responseTime,
      });

      this.logger.error(`Failed to fetch sector day candles for ${sectorCode}`, error);
      throw error;
    }
  }

  /**
   * 업종 현재가 조회 (ka20001)
   * @param marketType 시장구분 (0: 코스피, 1: 코스닥)
   * @param sectorCode 업종코드 (001: KOSPI, 101: KOSDAQ)
   */
  async getSectorCurrentPrice(
    marketType: '0' | '1' | '2',
    sectorCode: string,
  ): Promise<KiwoomSectorCurrentPriceResponse> {
    const startTime = Date.now();

    try {
      const token = await this.authService.ensureValidToken();

      this.logger.debug(`Fetching sector current price for ${sectorCode}`);

      const response = await this.httpClient.post<KiwoomSectorCurrentPriceResponse>(
        '/api/dostk/sect',
        {
          mrkt_tp: marketType,
          inds_cd: sectorCode,
        },
        {
          headers: {
            'api-id': 'ka20001',
            authorization: `Bearer ${token}`,
          },
        },
      );

      const responseTime = Date.now() - startTime;

      await this.logApiCall({
        apiName: 'ka20001',
        stockCode: sectorCode,
        requestData: { mrkt_tp: marketType, inds_cd: sectorCode },
        responseStatus: 'SUCCESS',
        responseMessage: response.data.return_msg,
        responseTimeMs: responseTime,
      });

      return response.data;
    } catch (error) {
      const responseTime = Date.now() - startTime;

      await this.logApiCall({
        apiName: 'ka20001',
        stockCode: sectorCode,
        requestData: { mrkt_tp: marketType, inds_cd: sectorCode },
        responseStatus: 'ERROR',
        responseMessage: error.message,
        responseTimeMs: responseTime,
      });

      this.logger.error(`Failed to fetch sector current price for ${sectorCode}`, error);
      throw error;
    }
  }

  /**
   * 시장별 투자자 순매수 조회 (ka10051)
   * 금액 기준, 통합거래소 기준으로 종합(KOSPI/KOSDAQ) 행을 사용한다.
   */
  async getMarketInvestorNetBuy(
    marketType: '0' | '1',
    baseDate: string,
  ): Promise<KiwoomMarketInvestorNetBuyResponse> {
    const startTime = Date.now();
    const requestData = {
      mrkt_tp: marketType,
      amt_qty_tp: '0',
      base_dt: baseDate,
      stex_tp: '3',
    };

    try {
      const token = await this.authService.ensureValidToken();
      const response = await this.httpClient.post<KiwoomMarketInvestorNetBuyResponse>(
        '/api/dostk/sect',
        requestData,
        {
          headers: {
            'api-id': 'ka10051',
            authorization: `Bearer ${token}`,
          },
        },
      );

      await this.logApiCall({
        apiName: 'ka10051',
        stockCode: marketType === '0' ? '001' : '101',
        requestData,
        responseStatus: 'SUCCESS',
        responseMessage: response.data.return_msg,
        responseTimeMs: Date.now() - startTime,
      });
      return response.data;
    } catch (error) {
      await this.logApiCall({
        apiName: 'ka10051',
        stockCode: marketType === '0' ? '001' : '101',
        requestData,
        responseStatus: 'ERROR',
        responseMessage: (error as Error).message,
        responseTimeMs: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * 시장별 52주 신고가/신저가 종목 조회 (ka10016)
   * 연속조회가 있으면 모든 페이지를 합쳐 반환한다.
   */
  async getNewHighLowStocks(
    marketType: '001' | '101',
    type: '1' | '2',
  ): Promise<KiwoomNewHighLowData[]> {
    const startTime = Date.now();
    const requestData = {
      mrkt_tp: marketType,
      ntl_tp: type,
      high_low_close_tp: '1',
      stk_cnd: '0',
      trde_qty_tp: '00000',
      crd_cnd: '0',
      updown_incls: '1',
      dt: '250',
      stex_tp: '3',
    };

    try {
      const token = await this.authService.ensureValidToken();
      const rows: KiwoomNewHighLowData[] = [];
      let contYn = '';
      let nextKey = '';

      for (let page = 0; page < 20; page++) {
        const response = await this.httpClient.post<KiwoomNewHighLowResponse>(
          '/api/dostk/stkinfo',
          requestData,
          {
            headers: {
              'api-id': 'ka10016',
              authorization: `Bearer ${token}`,
              ...(contYn === 'Y' ? { 'cont-yn': contYn, 'next-key': nextKey } : {}),
            },
          },
        );
        rows.push(...(response.data.ntl_pric ?? []));
        contYn = String(response.headers['cont-yn'] ?? '');
        nextKey = String(response.headers['next-key'] ?? '');
        if (contYn !== 'Y' || !nextKey) break;
      }

      await this.logApiCall({
        apiName: 'ka10016',
        stockCode: marketType,
        requestData,
        responseStatus: 'SUCCESS',
        responseMessage: `${type === '1' ? 'new-high' : 'new-low'} ${rows.length} rows`,
        responseTimeMs: Date.now() - startTime,
      });
      return rows;
    } catch (error) {
      await this.logApiCall({
        apiName: 'ka10016',
        stockCode: marketType,
        requestData,
        responseStatus: 'ERROR',
        responseMessage: (error as Error).message,
        responseTimeMs: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * 종목 리스트 조회 (ka10099)
   * @param marketType 시장구분 (0: 코스피, 10: 코스닥, 8: ETF)
   */
  async getStockList(
    marketType: '0' | '10' | '8' = '0',
    retryOnAuthError = true,
  ): Promise<KiwoomStockListResponse> {
    const startTime = Date.now();
    const allStocks: KiwoomStockListResponse['list'] = [];
    let contYn = '';
    let nextKey = '';

    try {
      const token = await this.authService.ensureValidToken();
      this.logger.debug(`Fetching stock list for market type: ${marketType}`);

      do {
        const headers: Record<string, string> = {
          'api-id': 'ka10099',
          authorization: `Bearer ${token}`,
        };

        if (contYn === 'Y') {
          headers['cont-yn'] = contYn;
          headers['next-key'] = nextKey;
        }

        const response = await this.httpClient.post<KiwoomStockListResponse>(
          '/api/dostk/stkinfo',
          { mrkt_tp: marketType },
          { headers },
        );

        // 토큰 인증 실패 감지 (return_code: 3)
        if (response.data.return_code === 3 && retryOnAuthError) {
          this.logger.warn(
            `Token authentication failed (${response.data.return_msg}). Invalidating tokens and retrying...`,
          );
          await this.authService.invalidateAllTokens();
          return this.getStockList(marketType, false); // 재시도 (1회만)
        }

        if (!response.data.list || !Array.isArray(response.data.list)) {
          this.logger.error(
            `Invalid stock list response. Response: ${JSON.stringify(response.data)}`,
          );
          throw new Error('Invalid stock list response format');
        }

        allStocks.push(...response.data.list);

        contYn = response.headers['cont-yn'] || '';
        nextKey = response.headers['next-key'] || '';

        this.logger.debug(`Fetched ${response.data.list.length} stocks, total: ${allStocks.length}, continue: ${contYn}`);
      } while (contYn === 'Y');

      const responseTime = Date.now() - startTime;

      await this.logApiCall({
        apiName: 'ka10099',
        requestData: { mrkt_tp: marketType },
        responseStatus: 'SUCCESS',
        responseMessage: `Total ${allStocks.length} stocks`,
        responseTimeMs: responseTime,
      });

      return {
        return_code: 0,
        return_msg: '정상적으로 처리되었습니다',
        list: allStocks,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;

      await this.logApiCall({
        apiName: 'ka10099',
        requestData: { mrkt_tp: marketType },
        responseStatus: 'ERROR',
        responseMessage: error.message,
        responseTimeMs: responseTime,
      });

      this.logger.error(`Failed to fetch stock list`, error);
      throw error;
    }
  }

  /**
   * API 호출 로그 저장
   */
  private async logApiCall(data: {
    apiName: string;
    stockCode?: string;
    requestData?: any;
    responseStatus?: string;
    responseMessage?: string;
    responseTimeMs?: number;
  }): Promise<void> {
    try {
      await this.prisma.kiwoomApiCallLog.create({
        data: {
          apiName: data.apiName,
          stockCode: data.stockCode,
          requestData: data.requestData,
          responseStatus: data.responseStatus,
          responseMessage: data.responseMessage,
          responseTimeMs: data.responseTimeMs,
        },
      });
    } catch (error) {
      this.logger.error('Failed to save API call log', error);
    }
  }
}
