import { Exclude, Expose } from 'class-transformer';

@Exclude()
export class UserResponseDto {
    @Expose()
        userId: bigint;

    @Expose()
        username: string;

    @Expose()
        email: string;

    @Expose()
        createdAt: Date;

    @Expose()
        updatedAt: Date;
}
