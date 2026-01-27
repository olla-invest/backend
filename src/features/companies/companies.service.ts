import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { MarketType } from '../../generated/prisma';

@Injectable()
export class CompaniesService {
    constructor( private readonly prisma: PrismaService ) {}

    async create( createCompanyDto: CreateCompanyDto ) {
        return this.prisma.company.create( {
            data: createCompanyDto,
        } );
    }

    async findAll() {
        return this.prisma.company.findMany( {
            where: {
                deletedAt: null,
            },
        } );
    }

    async findByMarketType( marketType: MarketType ) {
        return this.prisma.company.findMany( {
            where: {
                marketType,
                deletedAt: null,
            },
        } );
    }

    async findOne( companyId: bigint ) {
        return this.prisma.company.findUnique( {
            where: { companyId },
        } );
    }

    async findByStockCode( stockCode: string ) {
        return this.prisma.company.findFirst( {
            where: {
                stockCode,
                deletedAt: null,
            },
        } );
    }

    async update( companyId: bigint, updateCompanyDto: UpdateCompanyDto ) {
        return this.prisma.company.update( {
            where: { companyId },
            data: updateCompanyDto,
        } );
    }

    async softDelete( companyId: bigint ) {
        return this.prisma.company.update( {
            where: { companyId },
            data: {
                deletedAt: new Date(),
            },
        } );
    }

    async remove( companyId: bigint ) {
        return this.prisma.company.delete( {
            where: { companyId },
        } );
    }
}
