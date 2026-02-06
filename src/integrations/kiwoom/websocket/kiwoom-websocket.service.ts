import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import WebSocket from 'ws';
import { KiwoomAuthService } from '../auth/kiwoom-auth.service';
import {
  KiwoomRealtimeRequest,
  KiwoomRealtimeResponse,
} from '../types/kiwoom.types';

@Injectable()
export class KiwoomWebSocketService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KiwoomWebSocketService.name);
  private ws: WebSocket | null = null;
  private readonly wsUrl: string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private isLoggedIn = false;
  private pendingSubscriptions = false;
  private subscriptions = new Map<string, Set<string>>(); // stockCode -> Set<type>
  private subscriptionQueue: Array<{ stockCode: string; types: string[]; action: 'REG' | 'REMOVE' }> = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: KiwoomAuthService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    const useMock = this.configService.get<boolean>('KIWOOM_USE_MOCK') === true;

    this.wsUrl = useMock
      ? this.configService.get<string>('KIWOOM_MOCK_WS_URL')
      : this.configService.get<string>('KIWOOM_WS_URL');
  }

  async onModuleInit() {
    this.logger.log('Kiwoom WebSocket Service initialized');
    await this.connect();
  }

  onModuleDestroy() {
    this.disconnect();
  }

  /**
   * WebSocket 연결
   */
  private async connect(): Promise<void> {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isConnecting = true;

    try {
      const token = await this.authService.ensureValidToken();
      const wsFullUrl = `${this.wsUrl}/api/dostk/websocket`;

      this.logger.log(`Connecting to Kiwoom WebSocket: ${wsFullUrl}`);

      this.ws = new WebSocket(wsFullUrl, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      this.ws.on('open', () => this.onOpen());
      this.ws.on('message', (data) => this.onMessage(data));
      this.ws.on('error', (error) => this.onError(error));
      this.ws.on('close', (code, reason) => this.onClose(code, reason));
    } catch (error) {
      this.logger.error('Failed to connect to Kiwoom WebSocket', error);
      this.scheduleReconnect();
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * WebSocket 연결 성공
   */
  private onOpen(): void {
    this.logger.log('Kiwoom WebSocket connected, waiting for login confirmation...');
    this.startPing();
    this.isLoggedIn = false;
    this.pendingSubscriptions = true;
    this.subscriptionQueue = []; // 새 연결 시 큐 초기화
  }

  /**
   * WebSocket 메시지 수신
   */
  private onMessage(data: WebSocket.RawData): void {
    try {
      const message: KiwoomRealtimeResponse = JSON.parse(data.toString());

      // 메시지 상세 로깅 (항상 출력)
      this.logger.log(`Received message: trnm=${message.trnm}, return_code=${message.return_code}, readyState=${this.ws?.readyState}`);
      this.logger.debug(`Full message: ${JSON.stringify(message)}`);

      // 로그인 완료 체크 - 실제 성공 메시지인지 검증
      if (!this.isLoggedIn) {
        // SYSTEM 메시지는 로그인 확인이 아님 (시스템 알림, 종료 메시지 등)
        if (message.trnm === 'SYSTEM') {
          this.logger.warn(`Received SYSTEM message: ${message.return_msg || 'No message'}`);
          return;
        }

        // return_code가 0이 아니면 에러
        if (message.return_code !== undefined && message.return_code !== 0) {
          this.logger.error(`Login failed: ${message.return_msg || 'Unknown error'}`);
          return;
        }

        this.logger.log('Login confirmed, ready to subscribe');
        this.isLoggedIn = true;

        // 대기 중인 구독이 있으면 처리 (다음 이벤트 루프에서 실행)
        setImmediate(() => {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            this.logger.warn(`Cannot process subscriptions - WebSocket not open (readyState: ${this.ws?.readyState})`);
            return;
          }

          this.logger.log(`Processing pending subscriptions... readyState: ${this.ws?.readyState}`);

          // 기존 구독 재등록
          if (this.pendingSubscriptions) {
            this.pendingSubscriptions = false;
            this.resubscribeAll();
          }

          // 큐에 쌓인 구독 요청 처리
          if (this.subscriptionQueue.length > 0) {
            this.logger.log(`Processing ${this.subscriptionQueue.length} queued subscription requests`);
            const queue = [...this.subscriptionQueue];
            this.subscriptionQueue = [];

            for (const req of queue) {
              this.sendSubscription(req.stockCode, req.types, req.action);
            }
          }
        });
      }

      if (message.trnm === 'REAL' && message.data) {
        // 실시간 데이터 수신
        for (const realtimeData of message.data) {
          const { type, item, values } = realtimeData;

          this.logger.debug(`Received realtime data: ${type} ${item}`);

          // 이벤트 발행 (타입별)
          this.eventEmitter.emit(`kiwoom.realtime.${type}`, {
            stockCode: item,
            type,
            values,
          });

          // 이벤트 발행 (종목별)
          this.eventEmitter.emit(`kiwoom.realtime.${item}`, {
            stockCode: item,
            type,
            values,
          });
        }
      } else if (message.trnm === 'REG' || message.trnm === 'REMOVE') {
        // 등록/해지 응답
        if (message.return_code === 0) {
          this.logger.log(`Subscription ${message.trnm} successful`);
        } else {
          this.logger.error(`Subscription ${message.trnm} failed: ${message.return_msg}`);
        }
      }
    } catch (error) {
      this.logger.error('Failed to parse WebSocket message', error);
    }
  }

  /**
   * WebSocket 에러
   */
  private onError(error: Error): void {
    this.logger.error('Kiwoom WebSocket error', error);
  }

  /**
   * WebSocket 연결 종료
   */
  private onClose(code: number, reason: Buffer): void {
    const stack = new Error().stack;
    this.logger.warn(`Kiwoom WebSocket closed (code: ${code}, reason: ${reason.toString()})`);
    this.logger.debug(`Close stack trace: ${stack}`);
    this.isLoggedIn = false;
    this.pendingSubscriptions = false;

    // 큐 초기화 (재연결 시 다시 구독할 것임)
    if (this.subscriptionQueue.length > 0) {
      this.logger.debug(`Clearing ${this.subscriptionQueue.length} queued subscription requests`);
      this.subscriptionQueue = [];
    }

    this.stopPing();
    this.scheduleReconnect();
  }

  /**
   * 재연결 스케줄
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    // 장 시간 체크 (월~금 09:00 - 15:30)
    if (!this.isMarketHours()) {
      this.logger.log('Market is closed. WebSocket reconnection disabled.');
      return;
    }

    this.logger.log('Scheduling WebSocket reconnect in 5 seconds...');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  /**
   * 장 시간인지 확인 (월~금 09:00 - 15:30)
   */
  private isMarketHours(): boolean {
    const now = new Date();
    const koreaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));

    const day = koreaTime.getDay(); // 0: Sunday, 1: Monday, ..., 6: Saturday
    const hour = koreaTime.getHours();
    const minute = koreaTime.getMinutes();

    // 주말 체크
    if (day === 0 || day === 6) {
      return false;
    }

    // 장 시작 전 (09:00 이전)
    if (hour < 9) {
      return false;
    }

    // 장 마감 후 (15:30 이후)
    if (hour > 15 || (hour === 15 && minute >= 30)) {
      return false;
    }

    return true;
  }

  /**
   * Ping 시작 (연결 유지)
   */
  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000); // 30초마다 ping
  }

  /**
   * Ping 중지
   */
  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * WebSocket 연결 해제
   */
  private disconnect(): void {
    this.stopPing();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * 실시간 시세 구독
   */
  async subscribe(stockCode: string, types: string[]): Promise<void> {
    if (!this.subscriptions.has(stockCode)) {
      this.subscriptions.set(stockCode, new Set());
    }

    const stockTypes = this.subscriptions.get(stockCode)!;
    types.forEach((type) => stockTypes.add(type));

    // 로그인 전이면 큐에 추가
    if (!this.isLoggedIn) {
      this.logger.debug(`Queueing subscription for ${stockCode} (not logged in yet)`);
      this.subscriptionQueue.push({ stockCode, types, action: 'REG' });
      return;
    }

    await this.sendSubscription(stockCode, types, 'REG');
  }

  /**
   * 실시간 시세 구독 해제
   */
  async unsubscribe(stockCode: string, types?: string[]): Promise<void> {
    if (!this.subscriptions.has(stockCode)) {
      return;
    }

    const stockTypes = this.subscriptions.get(stockCode)!;

    if (types) {
      types.forEach((type) => stockTypes.delete(type));

      if (stockTypes.size === 0) {
        this.subscriptions.delete(stockCode);
      }

      // 로그인 전이면 큐에 추가
      if (!this.isLoggedIn) {
        this.logger.debug(`Queueing unsubscription for ${stockCode} (not logged in yet)`);
        this.subscriptionQueue.push({ stockCode, types, action: 'REMOVE' });
        return;
      }

      await this.sendSubscription(stockCode, types, 'REMOVE');
    } else {
      // 전체 해제
      const allTypes = Array.from(stockTypes);
      this.subscriptions.delete(stockCode);

      // 로그인 전이면 큐에 추가
      if (!this.isLoggedIn) {
        this.logger.debug(`Queueing unsubscription for ${stockCode} (not logged in yet)`);
        this.subscriptionQueue.push({ stockCode, types: allTypes, action: 'REMOVE' });
        return;
      }

      await this.sendSubscription(stockCode, allTypes, 'REMOVE');
    }
  }

  /**
   * 구독 요청 전송
   */
  private async sendSubscription(
    stockCode: string,
    types: string[],
    action: 'REG' | 'REMOVE',
  ): Promise<void> {
    this.logger.debug(`sendSubscription called: ${stockCode}, readyState: ${this.ws?.readyState}, OPEN: ${WebSocket.OPEN}`);

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(`WebSocket not connected, cannot send subscription. readyState: ${this.ws?.readyState}`);
      return;
    }

    const request: KiwoomRealtimeRequest = {
      trnm: action,
      grp_no: '1',
      refresh: '1',
      data: [
        {
          item: [stockCode],
          type: types,
        },
      ],
    };

    this.logger.debug(`Sending subscription ${action} for ${stockCode}: ${types.join(', ')}`);

    this.ws.send(JSON.stringify(request));
  }

  /**
   * 모든 구독 재등록 (재연결 시)
   */
  private async resubscribeAll(): Promise<void> {
    for (const [stockCode, types] of this.subscriptions.entries()) {
      await this.sendSubscription(stockCode, Array.from(types), 'REG');
    }
  }

  /**
   * 연결 상태 확인
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
