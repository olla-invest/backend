import { Exclude, Expose } from 'class-transformer';

@Exclude()
export class TagResponseDto {
    @Expose()
        tagId: bigint;

    @Expose()
        tagName: string;

    @Expose()
        createdAt: Date;
}
