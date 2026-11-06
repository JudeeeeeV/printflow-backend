import { IsBoolean, IsIn } from 'class-validator';

export class UpdateOrderStateDto {
  @IsBoolean()
  confirmed: boolean;

  @IsIn(['READY_FOR_PICKUP', 'COMPLETED'])
  state: 'READY_FOR_PICKUP' | 'COMPLETED';
}
