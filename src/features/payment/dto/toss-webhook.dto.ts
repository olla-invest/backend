import { IsString, IsNotEmpty, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class TossWebhookDataDto {
    @IsString()
    @IsNotEmpty()
    paymentKey: string;

    @IsString()
    @IsNotEmpty()
    orderId: string;

    @IsString()
    @IsNotEmpty()
    status: string;
}

export class TossWebhookDto {
    @IsString()
    @IsNotEmpty()
    eventType: string;

    @IsString()
    @IsNotEmpty()
    createdAt: string;

    @IsObject()
    @ValidateNested()
    @Type( () => TossWebhookDataDto )
    data: TossWebhookDataDto;
}
