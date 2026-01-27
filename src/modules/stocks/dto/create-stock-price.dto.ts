import { IsDate, IsNotEmpty, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateStockPriceDto {
    @IsNotEmpty()
        companyId: bigint;

    @IsDate()
    @Type( () => Date )
        tradeDate: Date;

    @IsNumber()
        openPrice: number;

    @IsNumber()
        highPrice: number;

    @IsNumber()
        lowPrice: number;

    @IsNumber()
        closePrice: number;

    @IsNotEmpty()
        volume: bigint;

    @IsNotEmpty()
        tradingValue: bigint;
}
