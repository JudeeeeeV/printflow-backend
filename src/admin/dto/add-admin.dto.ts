import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class AddAdminDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  @Matches(/[A-Z]/, { message: 'Password needs an uppercase letter' })
  @Matches(/[a-z]/, { message: 'Password needs a lowercase letter' })
  @Matches(/[0-9]/, { message: 'Password needs a number' })
  @Matches(/[^A-Za-z0-9\s]/, { message: 'Password needs a symbol' })
  password: string;
}
