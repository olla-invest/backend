import { Module } from '@nestjs/common';
import { DartRestService } from './dart-rest.service';

@Module({
  providers: [DartRestService],
  exports: [DartRestService],
})
export class DartModule {}
