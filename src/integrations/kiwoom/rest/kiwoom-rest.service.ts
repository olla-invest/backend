import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { KiwoomAuthService } from '../auth/kiwoom-auth.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  KiwoomMinCandleResponse,
  KiwoomTickCandleResponse,
  KiwoomDayCandleResponse,
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
