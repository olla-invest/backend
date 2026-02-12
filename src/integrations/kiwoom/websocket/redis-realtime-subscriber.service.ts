import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisPubSubService } from '../../../common/redis/redis-pubsub.service';
import { IRealtimeSource } from './realtime-source.interface';

@Injectable()
export class RedisRealtimeSubscriberService implements IRealtimeSource, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisRealtimeSubscriberService.name);
  private readonly enabled: boolean;
  private subscriptions = new Map<string, Set<string>>(); // stockCode -> Set<type>

  constructor(
    private readonly configService: ConfigService,
    private readonly redisPubSub: RedisPubSubService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.enabled = this.configService.get('REALTIME_SOURCE') === 'redis';
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.log('Redis realtime source is disabled (REALTIME_SOURCE != redis)');
      return;
    }

    this.logger.log('Initializing Redis realtime subscriber...');

    try {
      // 실시간 데이터 채널 구독
      await this.redisPubSub.subscribe('kiwoom:realtime:0B', (message) => {
        this.handleMessage(message, '0B');
      });

      await this.redisPubSub.subscribe('kiwoom:realtime:0D', (message) => {
        this.handleMessage(message, '0D');
      });

      // 상태 채널 구독 (선택사항)
      await this.redisPubSub.subscribe('kiwoom:status', (message) => {
        this.handleStatusMessage(message);
      });

      this.logger.log('Redis realtime subscriber initialized successfully');
    } catch (error) {
      this.logger.error(`Failed to initialize Redis realtime subscriber: ${error.message}`, error.stack);
      throw error;
    }
  }

  async onModuleDestroy() {
    if (!this.enabled) return;

    this.logger.log('Shutting down Redis realtime subscriber...');

    try {
      await this.redisPubSub.unsubscribe('kiwoom:realtime:0B');
      await this.redisPubSub.unsubscribe('kiwoom:realtime:0D');
      await this.redisPubSub.unsubscribe('kiwoom:status');

      this.logger.log('Redis realtime subscriber shut down');
    } catch (error) {
      this.logger.error(`Error during shutdown: ${error.message}`);
    }
  }

  /**
   * 실시간 데이터 메시지 처리
   * KiwoomWebSocketService.onMessage (line 154-165)와 동일한 이벤트 발행 패턴
   */
  private handleMessage(rawMessage: string, expectedType: string): void {
    try {
      const payload = JSON.parse(rawMessage);

      // 페이로드 검증
      const { stockCode, type, values } = payload;

      if (!stockCode || !type || !values) {
        this.logger.warn(`Invalid message format received from Redis: ${rawMessage}`);
        return;
      }

      if (type !== expectedType) {
        this.logger.warn(`Type mismatch: expected ${expectedType}, got ${type}`);
      }

      // 타입별 이벤트 발행 (KiwoomWebSocketService line 154와 동일)
      this.eventEmitter.emit(`kiwoom.realtime.${type}`, {
        stockCode,
        type,
        values,
      });

      // 종목별 이벤트 발행 (KiwoomWebSocketService line 161와 동일)
      this.eventEmitter.emit(`kiwoom.realtime.${stockCode}`, {
        stockCode,
        type,
        values,
      });

      this.logger.debug(`Redis -> EventEmitter: ${type} ${stockCode}`);
    } catch (error) {
      this.logger.error(`Failed to parse Redis message: ${error.message}`, error.stack);
    }
  }

  /**
   * 상태 메시지 처리
   */
  private handleStatusMessage(rawMessage: string): void {
    try {
      const status = JSON.parse(rawMessage);
      this.logger.log(`Windows program status: ${JSON.stringify(status)}`);
    } catch (error) {
      this.logger.error(`Failed to parse status message: ${error.message}`);
    }
  }

  /**
   * 종목 실시간 구독
   * Windows 프로그램에 구독 요청 발행
   */
  async subscribe(stockCode: string, types: string[]): Promise<void> {
    if (!this.subscriptions.has(stockCode)) {
      this.subscriptions.set(stockCode, new Set());
    }

    const stockTypes = this.subscriptions.get(stockCode)!;
    types.forEach((t) => stockTypes.add(t));

    // Windows 프로그램에 구독 요청 발행
    const request = {
      action: 'REG',
      stockCode,
      types,
      timestamp: new Date().toISOString(),
    };

    await this.redisPubSub.publish('kiwoom:subscription:request', JSON.stringify(request));

    this.logger.log(`Published subscription request: REG ${stockCode} [${types.join(', ')}]`);
  }

  /**
   * 종목 실시간 구독 해제
   * Windows 프로그램에 구독 해제 요청 발행
   */
  async unsubscribe(stockCode: string, types?: string[]): Promise<void> {
    const stockTypes = this.subscriptions.get(stockCode);
    const typesToRemove = types || (stockTypes ? Array.from(stockTypes) : ['0B', '0D']);

    if (types && stockTypes) {
      types.forEach((t) => stockTypes.delete(t));
      if (stockTypes.size === 0) {
        this.subscriptions.delete(stockCode);
      }
    } else {
      this.subscriptions.delete(stockCode);
    }

    // Windows 프로그램에 구독 해제 요청 발행
    const request = {
      action: 'REMOVE',
      stockCode,
      types: typesToRemove,
      timestamp: new Date().toISOString(),
    };

    await this.redisPubSub.publish('kiwoom:subscription:request', JSON.stringify(request));

    this.logger.log(`Published unsubscription request: REMOVE ${stockCode} [${typesToRemove.join(', ')}]`);
  }

  /**
   * 연결 상태 확인
   */
  isConnected(): boolean {
    return this.enabled && this.redisPubSub.isConnected();
  }
}
