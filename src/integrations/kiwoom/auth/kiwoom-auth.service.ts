import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { KiwoomTokenResponse } from '../types/kiwoom.types';

@Injectable()
export class KiwoomAuthService implements OnModuleInit {
  private readonly logger = new Logger(KiwoomAuthService.name);
  private readonly httpClient: AxiosInstance;
  private readonly appKey: string;
  private readonly secretKey: string;
  private readonly apiUrl: string;
  private readonly useMock: boolean;
  // 동시 토큰 발급 방지 락 (Node.js 싱글스레드 활용)
  private tokenIssuancePromise: Promise<string> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.appKey = this.configService.get<string>('KIWOOM_APP_KEY');
    this.secretKey = this.configService.get<string>('KIWOOM_SECRET_KEY');
    const useMockValue = this.configService.get('KIWOOM_USE_MOCK');
    this.useMock = useMockValue === true || useMockValue === 'true';

    this.apiUrl = this.useMock
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

  async onModuleInit() {
    this.logger.log(`Kiwoom Auth Service initialized (Mock: ${this.useMock})`);

    // 애플리케이션 시작 시 토큰 발급
    try {
      await this.ensureValidToken();
      this.logger.log('Initial token acquired successfully');
    } catch (error) {
      this.logger.error('Failed to acquire initial token', error);
    }
  }

  /**
   * 유효한 토큰을 보장 (없거나 만료되면 새로 발급)
   * 동시에 여러 호출이 오면 하나의 발급 요청만 실행하고 나머지는 대기
   */
  async ensureValidToken(): Promise<string> {
    const existingToken = await this.getValidToken();

    if (existingToken) {
      return existingToken;
    }

    // 이미 발급 중인 요청이 있으면 그것을 공유 (동시 발급 방지)
    if (!this.tokenIssuancePromise) {
      this.tokenIssuancePromise = this.issueToken().finally(() => {
        this.tokenIssuancePromise = null;
      });
    } else {
      this.logger.debug('Token issuance already in progress, waiting...');
    }

    return this.tokenIssuancePromise;
  }

  /**
   * DB에서 유효한 토큰 조회
   */
  private async getValidToken(): Promise<string | null> {
    const now = new Date();

    const token = await this.prisma.kiwoomToken.findFirst({
      where: {
        expiresAt: {
          gt: now,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (token) {
      this.logger.debug('Using existing valid token');
      return token.token;
    }

    return null;
  }

  /**
   * 새 토큰 발급
   */
  private async issueToken(): Promise<string> {
    const startTime = Date.now();

    try {
      this.logger.log('Issuing new access token...');

      const response = await this.httpClient.post<KiwoomTokenResponse>(
        '/oauth2/token',
        {
          grant_type: 'client_credentials',
          appkey: this.appKey,
          secretkey: this.secretKey,
        },
        {
          headers: {
            'api-id': 'au10001',
          },
        },
      );

      const { token, token_type, expires_dt, return_code, return_msg } = response.data;

      if (return_code !== 0) {
        throw new Error(`Token issuance failed: ${return_msg}`);
      }

      // 만료 시간 파싱 (YYYYMMDDHHmmss)
      const expiresAt = this.parseKiwoomDateTime(expires_dt);

      // DB에 저장
      await this.prisma.kiwoomToken.create({
        data: {
          token,
          tokenType: token_type,
          expiresAt,
        },
      });

      const responseTime = Date.now() - startTime;

      // API 호출 로그 저장
      await this.logApiCall({
        apiName: 'au10001',
        responseStatus: 'SUCCESS',
        responseMessage: return_msg,
        responseTimeMs: responseTime,
      });

      this.logger.log(`Token issued successfully (expires: ${expiresAt.toISOString()})`);

      return token;
    } catch (error) {
      const responseTime = Date.now() - startTime;

      await this.logApiCall({
        apiName: 'au10001',
        responseStatus: 'ERROR',
        responseMessage: error.message,
        responseTimeMs: responseTime,
      });

      this.logger.error('Failed to issue token', error);
      throw error;
    }
  }

  /**
   * 토큰 폐기
   */
  async revokeToken(token: string): Promise<void> {
    try {
      this.logger.log('Revoking access token...');

      await this.httpClient.post(
        '/oauth2/revoke',
        {
          appkey: this.appKey,
          secretkey: this.secretKey,
          token,
        },
        {
          headers: {
            'api-id': 'au10002',
            authorization: `Bearer ${token}`,
          },
        },
      );

      this.logger.log('Token revoked successfully');
    } catch (error) {
      this.logger.error('Failed to revoke token', error);
      throw error;
    }
  }

  /**
   * DB의 모든 토큰 무효화 (인증 실패 시 사용)
   */
  async invalidateAllTokens(): Promise<void> {
    try {
      this.logger.warn('Invalidating all tokens in database...');
      await this.prisma.kiwoomToken.deleteMany({});
      this.logger.log('All tokens invalidated');
    } catch (error) {
      this.logger.error('Failed to invalidate tokens', error);
      throw error;
    }
  }

  /**
   * 키움 날짜시간 문자열 파싱 (YYYYMMDDHHmmss)
   */
  private parseKiwoomDateTime(dateTimeStr: string): Date {
    // 키움 expires_dt는 KST(UTC+9) 기준 → ISO 형식으로 변환하여 정확히 파싱
    const year = dateTimeStr.substring(0, 4);
    const month = dateTimeStr.substring(4, 6);
    const day = dateTimeStr.substring(6, 8);
    const hour = dateTimeStr.substring(8, 10);
    const minute = dateTimeStr.substring(10, 12);
    const second = dateTimeStr.substring(12, 14);

    // KST = UTC+9 → +09:00 suffix 붙여서 파싱
    return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`);
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
