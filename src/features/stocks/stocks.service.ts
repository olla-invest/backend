// @ts-nocheck
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateStockPriceDto } from './dto/create-stock-price.dto';

@Injectable()
export class StocksService {
    constructor( private readonly prisma: PrismaService ) {}

    async create( createStockPriceDto: CreateStockPriceDto ) {
        return this.prisma.stockPriceHistory.create( {
            data: createStockPriceDto,
        } );
    }

    async createMany( createStockPriceDtos: CreateStockPriceDto[] ) {
        return this.prisma.stockPriceHistory.createMany( {
            data: createStockPriceDtos,
            skipDuplicates: true,
        } );
    }

    async findByCompany( companyId: string, limit?: number ) {
        return this.prisma.stockPriceHistory.findMany( {
            where: { companyId },
            orderBy: {
                tradeDate: 'desc',
            },
            take: limit,
        } );
    }

    async findByCompanyAndDateRange( companyId: string, startDate: Date, endDate: Date ) {
        return this.prisma.stockPriceHistory.findMany( {
            where: {
                companyId,
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

    async findLatestByCompany( companyId: string ) {
        return this.prisma.stockPriceHistory.findFirst( {
            where: { companyId },
            orderBy: {
                tradeDate: 'desc',
            },
        } );
    }

    async findByDate( tradeDate: Date ) {
        return this.prisma.stockPriceHistory.findMany( {
            where: { tradeDate },
            include: {
                company: true,
            },
        } );
    }
}
