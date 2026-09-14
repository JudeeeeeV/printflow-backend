import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MinLength,
  IsIn,
  ValidateIf,
  Matches,
  MaxLength,
} from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: 'Please provide a valid email' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @MaxLength(128)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9\s]).+$/, {
    message: 'Password must include uppercase, lowercase, a number, and a symbol',
  })
  password: string;

  @IsNotEmpty()
  @IsIn(['Student', 'Print Shop'], { message: 'Invalid account type' })
  accountType: string;

  @ValidateIf((dto: RegisterDto) => dto.accountType === 'Print Shop')
  @IsString()
  @Matches(/\S/, { message: 'Shop name is required for Print Shops' })
  @MaxLength(255)
  shopName?: string;
}
