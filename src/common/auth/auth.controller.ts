import { Body, Controller, Patch, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { FindIdDto } from './dto/find-id.dto';
import { FindPasswordDto } from './dto/find-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';

@Controller( 'auth' )
export class AuthController {
    constructor( private readonly authService: AuthService ) {}

    @Public()
    @Post( 'register' )
    register( @Body() dto: RegisterDto ) {
        return this.authService.register( dto );
    }

    @Public()
    @Post( 'login' )
    login( @Body() dto: LoginDto ) {
        return this.authService.login( dto );
    }

    @Public()
    @Post( 'find-id' )
    findId( @Body() dto: FindIdDto ) {
        return this.authService.findId( dto );
    }

    @Public()
    @Post( 'find-password' )
    findPassword( @Body() dto: FindPasswordDto ) {
        return this.authService.findPassword( dto );
    }

    @Patch( 'change-password' )
    changePassword(
        @CurrentUser( 'userId' ) userId: string,
        @Body() dto: ChangePasswordDto,
    ) {
        return this.authService.changePassword( userId, dto );
    }
}
