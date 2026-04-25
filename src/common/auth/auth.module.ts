import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { NaverStrategy } from './strategies/naver.strategy';
import { KakaoStrategy } from './strategies/kakao.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { EmailModule } from '../email/email.module';

@Module( {
    imports: [
        PassportModule.register( { defaultStrategy: 'jwt' } ),
        JwtModule.registerAsync( {
            imports: [ ConfigModule ],
            inject: [ ConfigService ],
            useFactory: async ( configService: ConfigService ) => ( {
                secret: configService.get<string>( 'JWT_SECRET' ),
                signOptions: {
                    expiresIn: configService.get<string>( 'JWT_EXPIRES_IN', '7d' ) as any,
                },
            } ),
        } ),
        EmailModule,
    ],
    controllers: [ AuthController ],
    providers: [ AuthService, JwtStrategy, NaverStrategy, KakaoStrategy, JwtAuthGuard ],
    exports: [ AuthService, JwtAuthGuard ],
} )
export class AuthModule {}
