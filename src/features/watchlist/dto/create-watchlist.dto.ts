import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateWatchlistDto {
    @IsNotEmpty()
        userId: bigint;

    @IsNotEmpty()
        companyId: bigint;

    @IsString()
    @IsOptional()
        memo?: string;
}
