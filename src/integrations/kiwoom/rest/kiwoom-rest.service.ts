import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { KiwoomAuthService } from '../auth/kiwoom-auth.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  KiwoomMinCandleResponse,
  KiwoomTickCandleResponse,
  KiwoomDayCandleResponse,
  KiwoomStockListResponse,
  KiwoomSectorDayCandleResponse,
  KiwoomSectorCurrentPriceResponse,
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
      this.logger.log(`Fetching stock list for market type: ${marketType}`);

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
