import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { FindIdDto } from './dto/find-id.dto';
import { FindPasswordDto } from './dto/find-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtPayload } from './strategies/jwt.strategy';

@Injectable()
export class AuthService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
        private readonly emailService: EmailService,
    ) {}

    async register( dto: RegisterDto ) {
        if ( !dto.agreeService || !dto.agreePrivacy ) {
            throw new BadRequestException( '필수 약관에 동의해주세요' );
        }

        const existingByUsername = await this.prisma.user.findFirst( {
            where: { username: dto.username, deletedAt: null },
        } );
        if ( existingByUsername ) {
            throw new ConflictException( '이미 사용 중인 ID입니다' );
        }

        const existingByEmail = await this.prisma.user.findFirst( {
            where: { email: dto.email, deletedAt: null },
        } );
        if ( existingByEmail ) {
            throw new ConflictException( '이미 사용 중인 이메일입니다' );
        }

        const hashedPassword = await bcrypt.hash( dto.password, 10 );

        const user = await this.prisma.user.create( {
            data: {
                username: dto.username,
                email: dto.email,
                password: hashedPassword,
                name: dto.name,
                phone: dto.phone,
                marketingConsent: dto.agreeMarketing ?? false,
            },
        } );

        return {
            userId: user.userId,
            username: user.username,
            email: user.email,
            name: user.name,
        };
    }

    async login( dto: LoginDto ) {
        const user = await this.prisma.user.findFirst( {
            where: { username: dto.username, deletedAt: null },
        } );

        if ( !user ) {
            throw new NotFoundException( '가입된 계정이 없습니다. 회원가입 후 이용해주세요.' );
        }

        const isPasswordValid = await bcrypt.compare( dto.password, user.password );
        if ( !isPasswordValid ) {
            throw new UnauthorizedException( '비밀번호가 일치하지 않습니다.' );
        }

        const payload: JwtPayload = {
            sub: user.userId,
            username: user.username,
            email: user.email,
        };

        const accessToken = this.jwtService.sign( payload );

        return {
            accessToken,
            user: {
                userId: user.userId,
                username: user.username,
                email: user.email,
                name: user.name,
                isTempPassword: user.isTempPassword,
            },
        };
    }

    async findId( dto: FindIdDto ) {
        const user = await this.prisma.user.findFirst( {
            where: {
                name: dto.name,
                email: dto.email,
                deletedAt: null,
            },
        } );

        if ( !user ) {
            throw new NotFoundException( '사용자 정보가 일치하지 않습니다' );
        }

        return { maskedUsername: this.maskUsername( user.username ) };
    }

    async findPassword( dto: FindPasswordDto ) {
        const user = await this.prisma.user.findFirst( {
            where: {
                username: dto.username,
                email: dto.email,
                deletedAt: null,
            },
        } );

        if ( !user ) {
            throw new NotFoundException(
                '입력하신 정보로 가입된 계정을 찾을 수 없습니다. 다시 확인해주세요.',
            );
        }

        const tempPassword = this.generateTempPassword();
        const hashedTemp = await bcrypt.hash( tempPassword, 10 );

        await this.prisma.user.update( {
            where: { userId: user.userId },
            data: { password: hashedTemp, isTempPassword: true },
        } );

        await this.emailService.sendTempPassword( user.email, tempPassword );

        return { email: user.email };
    }

    async changePassword( userId: string, dto: ChangePasswordDto ) {
        if ( dto.newPassword !== dto.confirmPassword ) {
            throw new BadRequestException( '비밀번호가 일치하지 않습니다.' );
        }

        const hashedPassword = await bcrypt.hash( dto.newPassword, 10 );

        await this.prisma.user.update( {
            where: { userId },
            data: { password: hashedPassword, isTempPassword: false },
        } );

        return { message: '비밀번호가 변경되었습니다.' };
    }

    async validateUser( userId: string ) {
        return this.prisma.user.findUnique( {
            where: { userId, deletedAt: null },
        } );
    }

    private maskUsername( username: string ): string {
        if ( username.length <= 4 ) {
            return username.slice( 0, 2 ) + '*'.repeat( username.length - 2 );
        }
        const visible = username.slice( 0, 4 );
        const last = username.slice( -1 );
        const masked = '*'.repeat( username.length - 5 );
        return visible + masked + last;
    }

    private generateTempPassword(): string {
        const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const lower = 'abcdefghijklmnopqrstuvwxyz';
        const digits = '0123456789';
        const special = '!@#$%^&*';
        const all = upper + lower + digits + special;

        const getRandom = ( chars: string ) =>
            chars[ crypto.randomInt( 0, chars.length ) ];

        // Ensure at least one of each required character type
        const required = [
            getRandom( upper ),
            getRandom( upper ),
            getRandom( lower ),
            getRandom( lower ),
            getRandom( digits ),
            getRandom( digits ),
            getRandom( special ),
            getRandom( special ),
        ];

        const remaining = Array.from( { length: 4 }, () => getRandom( all ) );
        const password = [ ...required, ...remaining ];

        // Shuffle
        for ( let i = password.length - 1; i > 0; i-- ) {
            const j = crypto.randomInt( 0, i + 1 );
            [ password[ i ], password[ j ] ] = [ password[ j ], password[ i ] ];
        }

        return password.join( '' );
    }
}
