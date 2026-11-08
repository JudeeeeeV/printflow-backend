import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import { OrdersService } from './orders.service';
import { PrintableDocumentService } from './printable-document.service';
import { SupabaseService } from '../supabase/supabase.service';

function fixture(bytes: Uint8Array) {
  const query = (data: Record<string, unknown>) => ({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data, error: null }),
  });
  const shop = query({ id: 'shop', verification_status: 'VERIFIED' });
  const owned = query({ id: 'order', state: 'OPEN_INQUIRY' });
  const asset = query({ file_type: 'PDF', file_url: 'stored/document.pdf' });
  const accepted = {
    id: 'order',
    state: 'IN_PRODUCTION',
    payment_method: 'CASH_ON_PICKUP',
    payment_status: 'DUE_AT_PICKUP',
    acceptance_status: 'ACCEPTED',
  };
  const rpc = jest.fn().mockReturnValue({
    abortSignal: jest.fn().mockResolvedValue({ data: accepted, error: null }),
  });
  const download = jest.fn().mockResolvedValue({
    data: { arrayBuffer: () => Promise.resolve(Uint8Array.from(bytes).buffer) },
    error: null,
  });
  const supabase = {
    from: (table: string) => {
      if (table === 'shops') return shop;
      if (table === 'orders') return owned;
      if (table === 'assets') return asset;
      throw new Error('Unexpected table');
    },
    rpc,
    storage: { from: () => ({ download }) },
  };
  const documents = new PrintableDocumentService();
  const normalize = jest.spyOn(documents, 'normalize');
  const service = new OrdersService(
    {
      getAdminClient: () => supabase,
      storagePath: () => 'stored/document.pdf',
    } as unknown as SupabaseService,
    documents,
  );
  return { service, owned, download, rpc, normalize, accepted };
}

describe('cash order acceptance', () => {
  it('validates the stored PDF without rebuilding it before accepting', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText('Already normalized document');
    const f = fixture(await pdf.save());
    const result = await f.service.decideOrder('shop', 'order', 'ACCEPT', {});
    expect(f.owned.eq).toHaveBeenCalledWith('shop_id', 'shop');
    expect(f.download).toHaveBeenCalledWith('stored/document.pdf');
    expect(f.normalize).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledWith('apply_order_decision', {
      p_order: 'order',
      p_actor: 'shop',
      p_actor_type: 'SHOP',
      p_action: 'ACCEPT',
      p_data: {},
    });
    expect(result.order).toEqual(f.accepted);
  });

  it('rejects an invalid document before changing order state', async () => {
    const f = fixture(Buffer.from('invalid PDF'));
    await expect(
      f.service.decideOrder('shop', 'order', 'ACCEPT', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('checks shop ownership before downloading private documents', async () => {
    const f = fixture(Buffer.from('unused'));
    f.owned.single.mockResolvedValue({ data: null, error: null });
    await expect(
      f.service.decideOrder('other-shop', 'order', 'ACCEPT', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.download).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
  });
});

describe('GCash verification authorizes production', () => {
  it('validates the owned PDF before approving the specific receipt', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const f = fixture(await pdf.save());
    await f.service.verifyPayment(
      'shop',
      'order',
      'APPROVE',
      undefined,
      'receipt',
      true,
    );
    expect(f.owned.eq).toHaveBeenCalledWith('shop_id', 'shop');
    expect(f.download).toHaveBeenCalledWith('stored/document.pdf');
    expect(f.normalize).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledWith('apply_order_decision', {
      p_order: 'order',
      p_actor: 'shop',
      p_actor_type: 'SHOP',
      p_action: 'VERIFY',
      p_data: { reason: undefined, receiptId: 'receipt', confirmed: true },
    });
  });
  it('rejects an invalid document before approving payment and production', async () => {
    const f = fixture(Buffer.from('invalid PDF'));
    await expect(
      f.service.verifyPayment(
        'shop',
        'order',
        'APPROVE',
        undefined,
        'receipt',
        true,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('rejects another shop before reading private file bytes', async () => {
    const f = fixture(Buffer.from('unused'));
    f.owned.single.mockResolvedValue({ data: null, error: null });
    await expect(
      f.service.verifyPayment(
        'other-shop',
        'order',
        'APPROVE',
        undefined,
        'receipt',
        true,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.download).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('allows closed-order receipt reconciliation without an available production file', async () => {
    const f = fixture(Buffer.from('unused'));
    f.owned.single.mockResolvedValue({
      data: { id: 'order', state: 'CANCELLED' },
      error: null,
    });
    await f.service.verifyPayment(
      'shop',
      'order',
      'APPROVE',
      undefined,
      'receipt',
      true,
    );
    expect(f.download).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalled();
  });
});
