import { IsString, IsUUID, Length } from 'class-validator';

export class ExchangeDaemonTokenDto {
  @IsUUID()
  deviceId: string;

  @IsString()
  @Length(32, 512)
  deviceSecret: string;
}
