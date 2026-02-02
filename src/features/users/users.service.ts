// @ts-nocheck
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
    constructor( private readonly prisma: PrismaService ) {}

    async create( createUserDto: CreateUserDto ) {
        return this.prisma.user.create( {
            data: createUserDto,
        } );
    }

    async findAll() {
        return this.prisma.user.findMany( {
            where: {
                deletedAt: null,
            },
        } );
    }

    async findOne( userId: bigint ) {
        return this.prisma.user.findUnique( {
            where: { userId },
        } );
    }

    async findByUsername( username: string ) {
        return this.prisma.user.findFirst( {
            where: {
                username,
                deletedAt: null,
            },
        } );
    }

    async findByEmail( email: string ) {
        return this.prisma.user.findFirst( {
            where: {
                email,
                deletedAt: null,
            },
        } );
    }

    async update( userId: bigint, updateUserDto: UpdateUserDto ) {
        return this.prisma.user.update( {
            where: { userId },
            data: updateUserDto,
        } );
    }

    async softDelete( userId: bigint ) {
        return this.prisma.user.update( {
            where: { userId },
            data: {
                deletedAt: new Date(),
            },
        } );
    }

    async remove( userId: bigint ) {
        return this.prisma.user.delete( {
            where: { userId },
        } );
    }
}
