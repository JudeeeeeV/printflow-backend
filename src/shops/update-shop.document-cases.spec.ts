import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SupabaseService } from '../supabase/supabase.service';
import { UpdateShopDto } from './dto/update-shop.dto';
import { ShopsService } from './shops.service';

type Result = { data: unknown; error: null | { code?: string; message: string } };
type DocumentCase = {
  id: string;
  title: string;
  update: Record<string, unknown>;
  expected: 'save' | 'bad-request' | 'not-found' | 'internal-error' | 'dto-invalid';
  payload?: Record<string, unknown>;
  errorMessage?: string;
  result?: Result;
};

function fixture(result?: Result) {
  const query = {
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(result ?? {
      data: { id: 'shop-1', availability_override: true, timezone: 'Asia/Manila' },
      error: null,
    }),
  };
  const from = jest.fn().mockReturnValue(query);
  const service = new ShopsService({
    getAdminClient: () => ({ from }),
  } as unknown as SupabaseService);
  return { service, query, from };
}

const repeat = (length: number) => 'x'.repeat(length);
const cases: DocumentCase[] = [
  { id: 'S01', title: 'save all supported fields', update: { name: '  Campus Print  ', location: '  Main gate  ', description: '  Student printing  ', latitude: 10, longitude: 123 }, expected: 'save', payload: { name: 'Campus Print', location: 'Main gate', description: 'Student printing', latitude: 10, longitude: 123 } },
  { id: 'S02', title: 'update a name without coordinates', update: { name: '  Campus Print  ' }, expected: 'save', payload: { name: 'Campus Print' } },
  { id: 'S03', title: 'clear both coordinates', update: { latitude: null, longitude: null }, expected: 'save', payload: { latitude: null, longitude: null } },
  { id: 'S04', title: 'reject latitude without longitude', update: { latitude: 10 }, expected: 'bad-request' },
  { id: 'S05', title: 'reject longitude without latitude', update: { longitude: 123 }, expected: 'bad-request' },
  { id: 'S06', title: 'reject latitude clear with numeric longitude', update: { latitude: null, longitude: 123 }, expected: 'bad-request' },
  { id: 'S07', title: 'reject numeric latitude with longitude clear', update: { latitude: 10, longitude: null }, expected: 'bad-request' },
  { id: 'S08', title: 'reject a name consisting of spaces', update: { name: '   ' }, expected: 'bad-request', errorMessage: 'Shop name cannot be empty.' },
  { id: 'S09', title: 'reject an empty patch', update: {}, expected: 'bad-request', errorMessage: 'No shop settings provided.' },
  { id: 'S10', title: 'allow an empty location', update: { location: '' }, expected: 'save', payload: { location: '' } },
  { id: 'S11', title: 'allow an empty description', update: { description: '' }, expected: 'save', payload: { description: '' } },
  { id: 'S12', title: 'handle a missing shop row', update: { name: 'Campus' }, expected: 'not-found', errorMessage: 'No shop is associated with this account.', result: { data: null, error: { code: 'PGRST116', message: 'no rows' } } },
  { id: 'S13', title: 'handle another database error', update: { name: 'Campus' }, expected: 'internal-error', errorMessage: 'Failed to update shop: invalid UUID', result: { data: null, error: { code: '22P02', message: 'invalid UUID' } } },
  { id: 'S14', title: 'latitude at min', update: { latitude: -90, longitude: 123 }, expected: 'save', payload: { latitude: -90, longitude: 123 } },
  { id: 'S15', title: 'latitude at min - 1', update: { latitude: -91, longitude: 123 }, expected: 'bad-request' },
  { id: 'S16', title: 'latitude at min + 1', update: { latitude: -89, longitude: 123 }, expected: 'save', payload: { latitude: -89, longitude: 123 } },
  { id: 'S17', title: 'latitude at max', update: { latitude: 90, longitude: 123 }, expected: 'save', payload: { latitude: 90, longitude: 123 } },
  { id: 'S18', title: 'latitude at max - 1', update: { latitude: 89, longitude: 123 }, expected: 'save', payload: { latitude: 89, longitude: 123 } },
  { id: 'S19', title: 'latitude at max + 1', update: { latitude: 91, longitude: 123 }, expected: 'bad-request' },
  { id: 'S20', title: 'latitude at nominal', update: { latitude: 10, longitude: 123 }, expected: 'save', payload: { latitude: 10, longitude: 123 } },
  { id: 'S21', title: 'longitude at min', update: { latitude: 10, longitude: -180 }, expected: 'save', payload: { latitude: 10, longitude: -180 } },
  { id: 'S22', title: 'longitude at min - 1', update: { latitude: 10, longitude: -181 }, expected: 'bad-request' },
  { id: 'S23', title: 'longitude at min + 1', update: { latitude: 10, longitude: -179 }, expected: 'save', payload: { latitude: 10, longitude: -179 } },
  { id: 'S24', title: 'longitude at max', update: { latitude: 10, longitude: 180 }, expected: 'save', payload: { latitude: 10, longitude: 180 } },
  { id: 'S25', title: 'longitude at max - 1', update: { latitude: 10, longitude: 179 }, expected: 'save', payload: { latitude: 10, longitude: 179 } },
  { id: 'S26', title: 'longitude at max + 1', update: { latitude: 10, longitude: 181 }, expected: 'bad-request' },
  { id: 'S27', title: 'longitude at nominal', update: { latitude: 10, longitude: 123 }, expected: 'save', payload: { latitude: 10, longitude: 123 } },
  { id: 'S28', title: 'reject non-finite latitude', update: { latitude: Number.NaN, longitude: 123 }, expected: 'bad-request' },
  { id: 'S29', title: 'reject non-finite longitude', update: { latitude: 10, longitude: Number.POSITIVE_INFINITY }, expected: 'bad-request' },
  { id: 'S30', title: 'name length at min', update: { name: repeat(1) }, expected: 'save', payload: { name: repeat(1) } },
  { id: 'S31', title: 'name length at min - 1', update: { name: repeat(0) }, expected: 'dto-invalid' },
  { id: 'S32', title: 'name length at min + 1', update: { name: repeat(2) }, expected: 'save', payload: { name: repeat(2) } },
  { id: 'S33', title: 'name length at max', update: { name: repeat(200) }, expected: 'save', payload: { name: repeat(200) } },
  { id: 'S34', title: 'name length at max - 1', update: { name: repeat(199) }, expected: 'save', payload: { name: repeat(199) } },
  { id: 'S35', title: 'name length at max + 1', update: { name: repeat(201) }, expected: 'dto-invalid' },
  { id: 'S36', title: 'name length at nominal', update: { name: repeat(20) }, expected: 'save', payload: { name: repeat(20) } },
  { id: 'S37', title: 'location length at min + 1', update: { location: repeat(1) }, expected: 'save', payload: { location: repeat(1) } },
  { id: 'S38', title: 'location length at max', update: { location: repeat(500) }, expected: 'save', payload: { location: repeat(500) } },
  { id: 'S39', title: 'location length at max - 1', update: { location: repeat(499) }, expected: 'save', payload: { location: repeat(499) } },
  { id: 'S40', title: 'location length at max + 1', update: { location: repeat(501) }, expected: 'dto-invalid' },
  { id: 'S41', title: 'location length at nominal', update: { location: repeat(20) }, expected: 'save', payload: { location: repeat(20) } },
  { id: 'S42', title: 'description length at min + 1', update: { description: repeat(1) }, expected: 'save', payload: { description: repeat(1) } },
  { id: 'S43', title: 'description length at max', update: { description: repeat(2000) }, expected: 'save', payload: { description: repeat(2000) } },
  { id: 'S44', title: 'description length at max - 1', update: { description: repeat(1999) }, expected: 'save', payload: { description: repeat(1999) } },
  { id: 'S45', title: 'description length at max + 1', update: { description: repeat(2001) }, expected: 'dto-invalid' },
  { id: 'S46', title: 'description length at nominal', update: { description: repeat(20) }, expected: 'save', payload: { description: repeat(20) } },
  { id: 'S47', title: 'reject non-string name', update: { name: null }, expected: 'dto-invalid' },
  { id: 'S48', title: 'reject non-string location', update: { location: 123 }, expected: 'dto-invalid' },
  { id: 'S49', title: 'reject non-string description', update: { description: null }, expected: 'dto-invalid' },
  { id: 'S50', title: 'clear coordinates while changing the name', update: { name: '  Campus Print  ', latitude: null, longitude: null }, expected: 'save', payload: { name: 'Campus Print', latitude: null, longitude: null } },
  { id: 'S51', title: 'reject invalid coordinates even with a valid name', update: { name: 'Campus Print', latitude: 10 }, expected: 'bad-request' },
  { id: 'C05', title: 'save availability hours and a GCash number supported by the current implementation', update: { availability_override: true, opens_at: '08:00', closes_at: '20:00', gcash_number: '09171234567' }, expected: 'save', payload: { availability_override: true, opens_at: '08:00', closes_at: '20:00', gcash_number: '09171234567' } },
  { id: 'C06', title: 'reject identical opening and closing times supported by the current implementation', update: { opens_at: '08:00', closes_at: '08:00' }, expected: 'bad-request', errorMessage: 'Opening and closing times must be different.' },
];

describe('Shop test cases from the CITU Software Test Document', () => {
  it.each(cases)('$id - $title', async (testCase) => {
    const f = fixture(testCase.result);
    const dto = plainToInstance(UpdateShopDto, testCase.update);

    if (testCase.expected === 'dto-invalid') {
      const validationErrors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      expect(validationErrors.length).toBeGreaterThan(0);
      expect(f.query.update).not.toHaveBeenCalled();
      return;
    }

    if (testCase.expected === 'save') {
      // Saves must also pass the global ValidationPipe rules, or the HTTP endpoint would return 400 first.
      const validationErrors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      expect(validationErrors).toEqual([]);
    }

    const call = f.service.updateShop('shop-1', dto);
    if (testCase.expected === 'bad-request') {
      await expect(call).rejects.toBeInstanceOf(BadRequestException);
      if (testCase.errorMessage) {
        await expect(call).rejects.toThrow(testCase.errorMessage);
      }
      expect(f.query.update).not.toHaveBeenCalled();
    } else if (testCase.expected === 'not-found') {
      await expect(call).rejects.toBeInstanceOf(NotFoundException);
      expect(f.query.update).toHaveBeenCalledTimes(1);
    } else if (testCase.expected === 'internal-error') {
      await expect(call).rejects.toBeInstanceOf(InternalServerErrorException);
      await expect(call).rejects.toThrow(
        new InternalServerErrorException(testCase.errorMessage),
      );
      expect(f.query.update).toHaveBeenCalledTimes(1);
    } else {
      await expect(call).resolves.toMatchObject({ id: 'shop-1' });
      expect(f.query.update).toHaveBeenCalledWith(testCase.payload);
      expect(f.query.eq).toHaveBeenCalledWith('id', 'shop-1');
    }
  });
});
