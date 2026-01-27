import { IsOptional, IsString } from 'class-validator';

export class UpdateWatchlistDto {
    @IsString()
    @IsOptional()
        memo?: string;
}
