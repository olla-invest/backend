import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { randomUUID } from 'crypto';

export type CronStatus = 'RUNNING' | 'SUCCESS' | 'FAILED';

/**
 * cron_run_log 테이블을 통한 크론 실행 이력 관리.
 *
 * - Prisma generate 재실행 없이 동작하도록 raw SQL 기반.
 * - 잡 시작 시 begin() → 종료 시 markSuccess() / markFailure()
 * - findUnfinishedDates() 로 catch-up 대상 조회 가능
 */
@Injectable()
export class CronRunLogService {
  private readonly logger = new Logger(CronRunLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 잡 실행 시작 기록. 동일 (jobName, tradeDate) 가 이미 SUCCESS면 RUNNING으로 갱신하지 않고 skip 신호 반환.
   * @returns runId (skip이 필요한 경우 null)
   */
  async begin(jobName: string, tradeDate: Date): Promise<string | null> {
    const dateOnly = this.toDateOnly(tradeDate);
    const runId = randomUUID();

    try {
      // 이미 SUCCESS면 skip
      const existing = await this.prisma.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM cron_run_log WHERE job_name = $1 AND trade_date = $2 LIMIT 1`,
        jobName,
        dateOnly,
      );
      if (existing.length > 0 && existing[0].status === 'SUCCESS') {
        return null;
      }

      // upsert (RUNNING 으로)
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO cron_run_log (run_id, job_name, trade_date, status, started_at)
         VALUES ($1::uuid, $2, $3, 'RUNNING', NOW())
         ON CONFLICT (job_name, trade_date) DO UPDATE
           SET status = 'RUNNING',
               started_at = NOW(),
               finished_at = NULL,
               duration_ms = NULL,
               error_msg = NULL`,
        runId,
        jobName,
        dateOnly,
      );
      return runId;
    } catch (err) {
      this.logger.warn(`begin() failed for ${jobName} ${dateOnly.toISOString()}: ${(err as Error).message}`);
      // 로그 테이블 자체에 문제가 있어도 본 작업은 계속 진행되도록 fallback
      return runId;
    }
  }

  async markSuccess(jobName: string, tradeDate: Date, durationMs: number, metadata?: Record<string, unknown>): Promise<void> {
    const dateOnly = this.toDateOnly(tradeDate);
    try {
      await this.prisma.$executeRawUnsafe(
        `UPDATE cron_run_log
            SET status = 'SUCCESS',
                finished_at = NOW(),
                duration_ms = $3,
                error_msg = NULL,
                metadata = $4::jsonb
          WHERE job_name = $1 AND trade_date = $2`,
        jobName,
        dateOnly,
        durationMs,
        metadata ? JSON.stringify(metadata) : null,
      );
    } catch (err) {
      this.logger.warn(`markSuccess() failed for ${jobName}: ${(err as Error).message}`);
    }
  }

  async markFailure(jobName: string, tradeDate: Date, durationMs: number, errorMsg: string): Promise<void> {
    const dateOnly = this.toDateOnly(tradeDate);
    try {
      await this.prisma.$executeRawUnsafe(
        `UPDATE cron_run_log
            SET status = 'FAILED',
                finished_at = NOW(),
                duration_ms = $3,
                error_msg = $4
          WHERE job_name = $1 AND trade_date = $2`,
        jobName,
        dateOnly,
        durationMs,
        errorMsg.slice(0, 2000),
      );
    } catch (err) {
      this.logger.warn(`markFailure() failed for ${jobName}: ${(err as Error).message}`);
    }
  }

  /**
   * 최근 N일 내에 SUCCESS 가 없거나 FAILED 인 trade_date 목록.
   * 호출측에서 catch-up 처리에 사용.
   */
  async findUnfinishedDates(jobName: string, recentDays: number): Promise<Date[]> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ trade_date: Date }[]>(
        `SELECT trade_date FROM cron_run_log
          WHERE job_name = $1
            AND trade_date >= NOW() - ($2 || ' days')::interval
            AND status <> 'SUCCESS'
          ORDER BY trade_date ASC`,
        jobName,
        String(recentDays),
      );
      return rows.map((r) => r.trade_date);
    } catch (err) {
      this.logger.warn(`findUnfinishedDates() failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * 잡 래퍼: begin → fn → markSuccess/markFailure 를 자동 처리.
   * skip된 경우(이미 SUCCESS) null을 반환.
   */
  async run<T>(
    jobName: string,
    tradeDate: Date,
    fn: () => Promise<T>,
    options: { metadata?: Record<string, unknown> } = {},
  ): Promise<T | null> {
    const runId = await this.begin(jobName, tradeDate);
    if (runId === null) {
      this.logger.log(`[${jobName}] already SUCCESS for ${this.toDateOnly(tradeDate).toISOString().slice(0, 10)} — skip`);
      return null;
    }

    const startedAt = Date.now();
    try {
      const result = await fn();
      await this.markSuccess(jobName, tradeDate, Date.now() - startedAt, options.metadata);
      return result;
    } catch (err) {
      await this.markFailure(jobName, tradeDate, Date.now() - startedAt, (err as Error).stack || (err as Error).message);
      throw err;
    }
  }

  private toDateOnly(date: Date): Date {
    // PostgreSQL DATE 컬럼에 정확히 매핑되도록 UTC 자정으로 정규화
    const d = new Date(date);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
}
