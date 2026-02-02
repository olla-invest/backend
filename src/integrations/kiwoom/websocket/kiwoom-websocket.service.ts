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
  private subscriptions = new Map<string, Set<string>>(); // stockCode -> Set<type>

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
    this.logger.log('Kiwoom WebSocket connected');
    this.startPing();

    // 기존 구독 재등록
    this.resubscribeAll();
  }

  /**
   * WebSocket 메시지 수신
   */
  private onMessage(data: WebSocket.RawData): void {
    try {
      const message: KiwoomRealtimeResponse = JSON.parse(data.toString());

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
    this.logger.warn(`Kiwoom WebSocket closed (code: ${code}, reason: ${reason.toString()})`);
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

    this.logger.log('Scheduling WebSocket reconnect in 5 seconds...');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
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

      await this.sendSubscription(stockCode, types, 'REMOVE');
    } else {
      // 전체 해제
      const allTypes = Array.from(stockTypes);
      this.subscriptions.delete(stockCode);
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn('WebSocket not connected, cannot send subscription');
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
