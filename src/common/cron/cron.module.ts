import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CronRunLogService } from './cron-run-log.service';

@Module({
  imports: [PrismaModule],
  providers: [CronRunLogService],
  exports: [CronRunLogService],
})
export class CronModule {}
