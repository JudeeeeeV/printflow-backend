import {
  IsNumber,
  IsString,
  Max,
  MaxLength,
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
}
