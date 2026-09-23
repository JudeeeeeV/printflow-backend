import { SupabaseService } from '../supabase/supabase.service';
import { OrdersService } from './orders.service';
import { PrintableDocumentService } from './printable-document.service';

describe('OrdersService.getDrafts', () => {
  it('uses the stored file path for the filename, not the signed URL query', async () => {
    const storedPath = 'client/order/document.pdf';
    const signedUrl =
      'https://example.test/storage/v1/object/sign/assets/client/order/document.pdf?token=example';
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockResolvedValue({
        data: [
          {
            id: 'order',
            total: 15,
            created_at: '2026-09-24T00:00:00.000Z',
            shop_id: 'shop',
            shops: { name: 'Print Shop' },
            assets: [{ file_url: storedPath }],
            paper_size: 'A4',
            print_color_mode: 'BLACK_AND_WHITE',
            page_count: 1,
          },
        ],
        error: null,
        count: 1,
      }),
    };
    const supabaseService = {
      getAdminClient: jest
        .fn()
        .mockReturnValue({ from: jest.fn().mockReturnValue(query) }),
      storagePath: jest.fn().mockReturnValue(storedPath),
      createSignedStorageUrl: jest.fn().mockResolvedValue(signedUrl),
    };
    const service = new OrdersService(
      supabaseService as unknown as SupabaseService,
      {} as PrintableDocumentService,
    );

    const result = await service.getDrafts('client');

    expect(supabaseService.storagePath).toHaveBeenCalledWith(
      storedPath,
      'assets',
    );
    expect(result.data[0].fileName).toBe('document.pdf');
    expect(result.data[0].fileUrl).toBe(signedUrl);
  });
});
