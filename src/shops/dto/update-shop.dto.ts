import {
  IsBoolean,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Matches,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class UpdateShopDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(500)
  location?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number | null;

  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  availability_override?: boolean;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  opens_at?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  closes_at?: string;

  @ValidateIf(
    (_, value) => value !== undefined && value !== null && value !== '',
  )
  @IsString()
  @Matches(/^09\d{9}$/, {
    message: 'GCash number must be an 11-digit Philippine mobile number.',
  })
  gcash_number?: string | null;
}
