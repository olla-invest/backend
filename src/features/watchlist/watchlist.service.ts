import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateWatchlistDto } from './dto/create-watchlist.dto';
import { UpdateWatchlistDto } from './dto/update-watchlist.dto';

@Injectable()
export class WatchlistService {
    constructor( private readonly prisma: PrismaService ) {}

    async create( createWatchlistDto: CreateWatchlistDto ) {
        return this.prisma.userWatchlist.create( {
            data: createWatchlistDto,
            include: {
                company: true,
            },
        } );
    }

    async findByUser( userId: string ) {
        return this.prisma.userWatchlist.findMany( {
            where: {
                userId,
                deletedAt: null,
            },
            include: {
                company: true,
                tags: {
                    include: {
                        tag: true,
                    },
                },
            },
            orderBy: {
                addedDate: 'desc',
            },
        } );
    }

    async findOne( userId: string, companyId: string ) {
        return this.prisma.userWatchlist.findUnique( {
            where: {
                userId_companyId: {
                    userId,
                    companyId,
                },
            },
            include: {
                company: true,
                tags: {
                    include: {
                        tag: true,
                    },
                },
            },
        } );
    }

    async update( userId: string, companyId: string, updateWatchlistDto: UpdateWatchlistDto ) {
        return this.prisma.userWatchlist.update( {
            where: {
                userId_companyId: {
                    userId,
                    companyId,
                },
            },
            data: updateWatchlistDto,
        } );
    }

    async softDelete( userId: string, companyId: string ) {
        return this.prisma.userWatchlist.update( {
            where: {
                userId_companyId: {
                    userId,
                    companyId,
                },
            },
            data: {
                deletedAt: new Date(),
            },
        } );
    }

    async remove( userId: string, companyId: string ) {
        return this.prisma.userWatchlist.delete( {
            where: {
                userId_companyId: {
                    userId,
                    companyId,
                },
            },
        } );
    }
}
