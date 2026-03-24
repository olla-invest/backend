import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class FindPasswordDto {
    @IsString()
    @IsNotEmpty( { message: 'ID를 입력해주세요' } )
    @MaxLength( 50 )
    username: string;

    @IsEmail( {}, { message: '올바른 이메일 형식을 입력해주세요' } )
    @IsNotEmpty()
    @MaxLength( 100 )
    email: string;
}
