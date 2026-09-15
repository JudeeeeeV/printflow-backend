import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

describe('OrdersController', () => {
  it('should be defined', () => {
    const controller = new OrdersController({} as OrdersService);
    expect(controller).toBeDefined();
  });
});
