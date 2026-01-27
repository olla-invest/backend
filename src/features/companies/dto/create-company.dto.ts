import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { MarketType } from '../../../generated/prisma';

export class CreateCompanyDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength( 100 )
        companyName: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength( 20 )
        stockCode: string;

    @IsEnum( MarketType )
    @IsNotEmpty()
        marketType: MarketType;
}
