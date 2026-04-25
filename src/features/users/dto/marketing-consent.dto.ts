import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class MarketingConsentDto {
    @ApiProperty( { example: true, description: '마케팅 수신 동의 여부 (true: 동의, false: 거부)' } )
    @IsBoolean()
    consent: boolean;
}
