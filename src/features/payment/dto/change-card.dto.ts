import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangeCardDto {
    @ApiProperty( { description: 'Toss Payments 빌링키 발급 인증 키 (클라이언트에서 발급)' } )
    @IsString()
    @IsNotEmpty()
    authKey: string;

    @ApiProperty( { description: '고객 키 (클라이언트에서 생성한 UUID)' } )
    @IsString()
    @IsNotEmpty()
    customerKey: string;
}
