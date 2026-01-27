import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateMarketIndexDto } from './dto/create-market-index.dto';
import { MarketIndexType } from '../../generated/prisma';

@Injectable()
export class MarketService {
    constructor( private readonly prisma: PrismaService ) {}

    async create( createMarketIndexDto: CreateMarketIndexDto ) {
        return this.prisma.marketIndexHistory.create( {
            data: createMarketIndexDto,
        } );
    }

    async createMany( createMarketIndexDtos: CreateMarketIndexDto[] ) {
        return this.prisma.marketIndexHistory.createMany( {
            data: createMarketIndexDtos,
            skipDuplicates: true,
        } );
    }

    async findByMarketType( marketType: MarketIndexType, limit?: number ) {
        return this.prisma.marketIndexHistory.findMany( {
            where: { marketType },
            orderBy: {
                tradeDate: 'desc',
            },
            take: limit,
        } );
    }

    async findByMarketTypeAndDateRange(
        marketType: MarketIndexType,
        startDate: Date,
        endDate: Date,
    ) {
        return this.prisma.marketIndexHistory.findMany( {
            where: {
                marketType,
                tradeDate: {
                    gte: startDate,
                    lte: endDate,
                },
            },
            orderBy: {
                tradeDate: 'asc',
            },
        } );
    }

    async findLatestByMarketType( marketType: MarketIndexType ) {
        return this.prisma.marketIndexHistory.findFirst( {
            where: { marketType },
            orderBy: {
                tradeDate: 'desc',
            },
        } );
    }

    async findByDate( tradeDate: Date ) {
        return this.prisma.marketIndexHistory.findMany( {
            where: { tradeDate },
        } );
    }
}
