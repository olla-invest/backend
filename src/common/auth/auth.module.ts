import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

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
    ],
    providers: [ AuthService, JwtStrategy, JwtAuthGuard ],
    exports: [ AuthService, JwtAuthGuard ],
} )
export class AuthModule {}
