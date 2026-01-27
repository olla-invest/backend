import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';

@Injectable()
export class TagsService {
    constructor( private readonly prisma: PrismaService ) {}

    async create( createTagDto: CreateTagDto ) {
        return this.prisma.tag.create( {
            data: createTagDto,
        } );
    }

    async findAll() {
        return this.prisma.tag.findMany( {
            where: {
                deletedAt: null,
            },
        } );
    }

    async findOne( tagId: bigint ) {
        return this.prisma.tag.findUnique( {
            where: { tagId },
        } );
    }

    async findByName( tagName: string ) {
        return this.prisma.tag.findFirst( {
            where: {
                tagName,
                deletedAt: null,
            },
        } );
    }

    async update( tagId: bigint, updateTagDto: UpdateTagDto ) {
        return this.prisma.tag.update( {
            where: { tagId },
            data: updateTagDto,
        } );
    }

    async softDelete( tagId: bigint ) {
        return this.prisma.tag.update( {
            where: { tagId },
            data: {
                deletedAt: new Date(),
            },
        } );
    }

    async remove( tagId: bigint ) {
        return this.prisma.tag.delete( {
            where: { tagId },
        } );
    }
}
