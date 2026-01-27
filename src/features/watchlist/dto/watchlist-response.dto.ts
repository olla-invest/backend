import { Exclude, Expose } from 'class-transformer';

@Exclude()
export class WatchlistResponseDto {
    @Expose()
        userId: bigint;

    @Expose()
        companyId: bigint;

    @Expose()
        addedDate: Date;

    @Expose()
        memo?: string;
}
