import { IsNotEmpty, IsOptional, IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
    @ApiProperty( { example: 'currentPassword123!', description: '현재 비밀번호 (임시 비밀번호 변경 시 생략 가능)' , required: false } )
    @IsOptional()
    @IsString()
    currentPassword?: string;

    @ApiProperty( { example: 'newPassword123!', description: '새 비밀번호 (8자 이상)' } )
    @IsString()
    @IsNotEmpty( { message: '새 비밀번호를 입력해주세요' } )
    @MinLength( 8, { message: '8자 이상 입력해주세요' } )
    @MaxLength( 50 )
    newPassword: string;

    @ApiProperty( { example: 'newPassword123!', description: '새 비밀번호 확인' } )
    @IsString()
    @IsNotEmpty( { message: '비밀번호 재확인을 입력해주세요' } )
    confirmPassword: string;
}
