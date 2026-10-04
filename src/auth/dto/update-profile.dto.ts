import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

const normalizeName = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

export class UpdateProfileDto {
  @Transform(normalizeName)
  @IsString()
  @Length(1, 100)
  firstName!: string;

  @Transform(normalizeName)
  @IsString()
  @Length(1, 100)
  lastName!: string;
}
