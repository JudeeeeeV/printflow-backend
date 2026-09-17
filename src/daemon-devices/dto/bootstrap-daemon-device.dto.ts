import {
  IsEmail,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

export class BootstrapDaemonDeviceDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  @IsString()
  @Length(1, 120)
  deviceName: string;

  @IsString()
  @MaxLength(40)
  agentVersion: string;
}
