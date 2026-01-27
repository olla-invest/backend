import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';
import { JwtPayload } from './strategies/jwt.strategy';

@Injectable()
export class AuthService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
    ) {}

    async register( registerDto: RegisterDto ) {
        // Check if user exists
        const existingUser = await this.prisma.user.findFirst( {
            where: {
                OR: [
                    { username: registerDto.username, deletedAt: null },
                    { email: registerDto.email, deletedAt: null },
                ],
            },
        } );

        if( existingUser ) {
            throw new ConflictException( 'Username or email already exists' );
        }

        // Hash password
        const hashedPassword = await bcrypt.hash( registerDto.password, 10 );

        // Create user
        const user = await this.prisma.user.create( {
            data: {
                username: registerDto.username,
                email: registerDto.email,
                password: hashedPassword,
            },
        } );

        // Generate JWT
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
            },
        };
    }

    async login( loginDto: LoginDto ) {
        // Find user
        const user = await this.prisma.user.findFirst( {
            where: {
                username: loginDto.username,
                deletedAt: null,
            },
        } );

        if( !user ) {
            throw new UnauthorizedException( 'Invalid credentials' );
        }

        // Verify password
        const isPasswordValid = await bcrypt.compare( loginDto.password, user.password );

        if( !isPasswordValid ) {
            throw new UnauthorizedException( 'Invalid credentials' );
        }

        // Generate JWT
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
            },
        };
    }

    async validateUser( userId: string ) {
        return this.prisma.user.findUnique( {
            where: {
                userId,
                deletedAt: null,
            },
        } );
    }
}
