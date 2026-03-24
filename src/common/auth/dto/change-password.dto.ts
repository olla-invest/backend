import { IsNotEmpty, IsString, MinLength, MaxLength } from 'class-validator';

export class ChangePasswordDto {
    @IsString()
    @IsNotEmpty( { message: '새 비밀번호를 입력해주세요' } )
    @MinLength( 8, { message: '8자 이상 입력해주세요' } )
    @MaxLength( 50 )
    newPassword: string;

    @IsString()
    @IsNotEmpty( { message: '비밀번호 재확인을 입력해주세요' } )
    confirmPassword: string;
}
