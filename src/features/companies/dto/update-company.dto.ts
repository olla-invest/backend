import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { MarketType } from '../../../generated/prisma';

export class UpdateCompanyDto {
    @IsString()
    @IsOptional()
    @MaxLength( 100 )
        companyName?: string;

    @IsString()
    @IsOptional()
    @MaxLength( 20 )
        stockCode?: string;

    @IsEnum( MarketType )
    @IsOptional()
        marketType?: MarketType;
}
