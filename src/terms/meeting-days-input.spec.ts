import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { normalizeMeetingDays } from './terms.service';
import { CreateTermDto } from './dto/create-term.dto';
import { UpdateTermDto } from './dto/update-term.dto';

describe('course meeting days input', () => {
  it('normalises and sorts', () => {
    expect(normalizeMeetingDays([6], [4])).toEqual({
      requiredDays: [6],
      optionalDays: [4],
    });
    expect(normalizeMeetingDays([3, 6, 1, 6], [])).toEqual({
      requiredDays: [1, 3, 6],
      optionalDays: [],
    });
  });

  it('refuses a day that is both required and optional', () => {
    expect(() => normalizeMeetingDays([6, 4], [4])).toThrow(
      BadRequestException,
    );
  });

  it('accepts valid weekdays in the DTOs', async () => {
    const create = plainToInstance(CreateTermDto, {
      name: 'winter-2027-2028',
      nameAr: 'الدورة الشتوية',
      startDate: '2027-09-18',
      requiredDays: [6],
      optionalDays: [4],
    });
    expect(await validate(create)).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(UpdateTermDto, { requiredDays: [6, 1, 3] }),
      ),
    ).toHaveLength(0);
  });

  it('rejects weekdays outside 1..7, duplicates and non-integers', async () => {
    for (const bad of [[0], [8], [6, 6], [1.5], ['6']]) {
      const errors = await validate(
        plainToInstance(UpdateTermDto, { requiredDays: bad }),
      );
      expect(errors.length).toBeGreaterThan(0);
    }
  });
});
