import { IsDate, IsEnum, IsNotEmpty, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';
import { MarketIndexType } from '@generated/prisma';

export class CreateMarketIndexDto {
    @IsEnum( MarketIndexType )
    @IsNotEmpty()
        marketType: MarketIndexType;

    @IsDate()
    @Type( () => Date )
        tradeDate: Date;

    @IsNumber()
        closeIndex: number;
}
