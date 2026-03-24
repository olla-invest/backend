import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class FindIdDto {
    @IsString()
    @IsNotEmpty( { message: '이름을 입력해주세요' } )
    @MaxLength( 100 )
    name: string;

    @IsEmail( {}, { message: '올바른 이메일 형식을 입력해주세요' } )
    @IsNotEmpty()
    @MaxLength( 100 )
    email: string;
}
