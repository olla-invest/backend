import { Exclude, Expose } from 'class-transformer';
import { MarketType } from '../../../generated/prisma';

@Exclude()
export class CompanyResponseDto {
    @Expose()
        companyId: bigint;

    @Expose()
        companyName: string;

    @Expose()
        stockCode: string;

    @Expose()
        marketType: MarketType;

    @Expose()
        createdAt: Date;

    @Expose()
        updatedAt: Date;
}
