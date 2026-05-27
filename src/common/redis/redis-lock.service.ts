import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';
import { randomUUID } from 'crypto';

/**
 * Redis 기반 분산락 서비스
 *
 * - SET NX + PX TTL 로 atomic acquire
 * - lockToken을 비교한 후에만 release (다른 인스턴스의 락을 실수로 풀지 않도록 Lua 스크립트 사용)
 * - 다중 인스턴스 환경에서 cron 중복 실행을 방지하기 위한 용도
 */
@Injectable()
export class RedisLockService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisLockService.name);
  private client: RedisClientType;

  private static readonly RELEASE_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  constructor(private readonly configService: ConfigService) {
    this.client = createClient({
      socket: {
        host: this.configService.get<string>('REDIS_HOST', 'localhost'),
        port: this.configService.get<number>('REDIS_PORT', 6379),
      },
      password: this.configService.get<string>('REDIS_PASSWORD'),
    }) as RedisClientType;

    this.client.on('error', (err) => {
      this.logger.error('Redis Lock Client Error', err);
    });
  }

  async onModuleInit() {
    if (!this.client.isOpen) {
      await this.client.connect();
      this.logger.log('Redis Lock client connected');
    }
  }

  async onModuleDestroy() {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  /**
   * 락 획득 시도
   * @returns 성공 시 release용 토큰, 실패 시 null
   */
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const result = await this.client.set(key, token, {
      NX: true,
      PX: ttlMs,
    });
    return result === 'OK' ? token : null;
  }

  /**
   * 락 해제 (소유 토큰 일치 시에만)
   */
  async release(key: string, token: string): Promise<boolean> {
    try {
      const res = (await this.client.eval(RedisLockService.RELEASE_SCRIPT, {
        keys: [key],
        arguments: [token],
      })) as number;
      return res === 1;
    } catch (err) {
      this.logger.warn(`Lock release failed for ${key}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * 락 획득 → 콜백 실행 → 자동 해제
   * 락 획득 실패 시 null 반환 (호출측에서 skip 처리)
   */
  async withLock<T>(
    key: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const token = await this.acquire(key, ttlMs);
    if (!token) {
      this.logger.warn(`Lock not acquired: ${key} (already held)`);
      return null;
    }
    try {
      return await fn();
    } finally {
      await this.release(key, token);
    }
  }
}
