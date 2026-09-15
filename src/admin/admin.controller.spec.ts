import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

describe('AdminController', () => {
  it('should be defined', () => {
    const controller = new AdminController({} as AdminService);
    expect(controller).toBeDefined();
  });
});
