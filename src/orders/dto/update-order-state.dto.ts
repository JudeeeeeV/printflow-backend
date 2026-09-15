import { IsIn } from 'class-validator';

export class UpdateOrderStateDto {
  @IsIn(['READY_FOR_PICKUP', 'COMPLETED'])
  state: 'READY_FOR_PICKUP' | 'COMPLETED';
}
