import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';

@Injectable()
export class RedisPubSubService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisPubSubService.name);
  private subscriberClient: RedisClientType;
  private publisherClient: RedisClientType;
  private messageHandlers = new Map<string, (message: string, channel: string) => void>();

  constructor(private readonly configService: ConfigService) {
    const redisConfig = {
      socket: {
        host: this.configService.get<string>('REDIS_HOST', 'localhost'),
        port: this.configService.get<number>('REDIS_PORT', 6379),
      },
      password: this.configService.get<string>('REDIS_PASSWORD'),
    };

    this.subscriberClient = createClient(redisConfig) as RedisClientType;
    this.publisherClient = createClient(redisConfig) as RedisClientType;

    // 에러 핸들러
    this.subscriberClient.on('error', (err) => {
      this.logger.error('Redis Subscriber Client Error', err);
    });

    this.publisherClient.on('error', (err) => {
      this.logger.error('Redis Publisher Client Error', err);
    });
  }

  async onModuleInit() {
    this.logger.log('Connecting Redis Pub/Sub clients...');

    await this.subscriberClient.connect();
    await this.publisherClient.connect();

    this.logger.log('Redis Pub/Sub clients connected');
  }

  async onModuleDestroy() {
    this.logger.log('Disconnecting Redis Pub/Sub clients...');

    await this.subscriberClient.quit();
    await this.publisherClient.quit();

    this.logger.log('Redis Pub/Sub clients disconnected');
  }

  /**
   * 채널 구독
   */
  async subscribe(channel: string, callback: (message: string, channel: string) => void): Promise<void> {
    this.logger.log(`Subscribing to channel: ${channel}`);

    this.messageHandlers.set(channel, callback);

    await this.subscriberClient.subscribe(channel, (message, subscribedChannel) => {
      const handler = this.messageHandlers.get(subscribedChannel);
      if (handler) {
        handler(message, subscribedChannel);
      }
    });

    this.logger.log(`Subscribed to channel: ${channel}`);
  }

  /**
   * 채널 구독 해제
   */
  async unsubscribe(channel: string): Promise<void> {
    this.logger.log(`Unsubscribing from channel: ${channel}`);

    await this.subscriberClient.unsubscribe(channel);
    this.messageHandlers.delete(channel);

    this.logger.log(`Unsubscribed from channel: ${channel}`);
  }

  /**
   * 메시지 발행
   */
  async publish(channel: string, message: string): Promise<number> {
    const receivers = await this.publisherClient.publish(channel, message);
    this.logger.debug(`Published to ${channel}: ${receivers} receivers`);
    return receivers;
  }

  /**
   * 연결 상태 확인
   */
  isConnected(): boolean {
    return this.subscriberClient.isOpen && this.publisherClient.isOpen;
  }
}
