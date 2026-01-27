import { Exclude, Expose } from 'class-transformer';

@Exclude()
export class StockPriceResponseDto {
    @Expose()
        priceId: bigint;

    @Expose()
        companyId: bigint;

    @Expose()
        tradeDate: Date;

    @Expose()
        openPrice: number;

    @Expose()
        highPrice: number;

    @Expose()
        lowPrice: number;

    @Expose()
        closePrice: number;

    @Expose()
        volume: bigint;

    @Expose()
        tradingValue: bigint;

    @Expose()
        createdAt: Date;
}
