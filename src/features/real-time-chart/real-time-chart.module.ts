import { Module } from '@nestjs/common';
import { RealTimeChartController } from './real-time-chart.controller';
import { RealTimeChartService } from './real-time-chart.service';

@Module( {
    controllers: [ RealTimeChartController ],
    providers: [ RealTimeChartService ],
    exports: [ RealTimeChartService ],
} )
export class RealTimeChartModule {}
