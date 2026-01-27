import { Exclude, Expose } from 'class-transformer';
import { MarketIndexType } from '../../../generated/prisma';

@Exclude()
export class MarketIndexResponseDto {
    @Expose()
        indexId: bigint;

    @Expose()
        marketType: MarketIndexType;

    @Expose()
        tradeDate: Date;

    @Expose()
        closeIndex: number;

    @Expose()
        createdAt: Date;
}
