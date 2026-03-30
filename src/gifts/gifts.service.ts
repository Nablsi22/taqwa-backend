import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class GiftsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(onlyAvailable = false) {
    const where: any = {};
    if (onlyAvailable) {
      where.isAvailable = true;
    }

    const gifts = await this.prisma.gift.findMany({
      where,
      orderBy: { pointsCost: 'asc' },
    });

    return { data: gifts };
  }

  async findOne(id: string) {
    const gift = await this.prisma.gift.findUnique({ where: { id } });
    if (!gift) throw new NotFoundException('الهدية غير موجودة');
    return gift;
  }

  async create(dto: {
    name: string;
    description?: string;
    imageData?: string;
    pointsCost: number;
    isAvailable?: boolean;
  }) {
    const gift = await this.prisma.gift.create({
      data: {
        name: dto.name,
        description: dto.description || null,
        imageData: dto.imageData || null,
        pointsCost: dto.pointsCost,
        isAvailable: dto.isAvailable ?? true,
      },
    });

    return { message: 'تم إضافة الهدية بنجاح', data: gift };
  }

  async update(
    id: string,
    dto: {
      name?: string;
      description?: string;
      imageData?: string;
      pointsCost?: number;
      isAvailable?: boolean;
    },
  ) {
    await this.findOne(id);

    const gift = await this.prisma.gift.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.imageData !== undefined && { imageData: dto.imageData }),
        ...(dto.pointsCost !== undefined && { pointsCost: dto.pointsCost }),
        ...(dto.isAvailable !== undefined && { isAvailable: dto.isAvailable }),
      },
    });

    return { message: 'تم تحديث الهدية بنجاح', data: gift };
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.gift.delete({ where: { id } });
    return { message: 'تم حذف الهدية بنجاح' };
  }
}
