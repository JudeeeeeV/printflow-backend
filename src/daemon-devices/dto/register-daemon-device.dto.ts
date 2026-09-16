import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class RegisterDaemonDeviceDto {
  @IsString()
  @Length(1, 120)
  deviceName: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  agentVersion?: string;
}
