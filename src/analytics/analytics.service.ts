import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  async getShopAnalytics(shopId: string, startDate?: string, endDate?: string) {
    const supabase = this.supabaseService.getAdminClient();
    
    // Query all non-draft orders for the shop to get a complete picture
    let query = supabase
      .from('orders')
      .select('id, total, created_at, state, client_id, assets(file_url)')
      .eq('shop_id', shopId)
      .neq('state', 'DRAFT')
      .order('created_at', { ascending: false });

    if (startDate) {
      query = query.gte('created_at', startDate);
    }
    if (endDate) {
      query = query.lte('created_at', endDate);
    }

    const { data: orders, error } = await query;

    if (error) {
      this.logger.error('Failed to fetch analytics: ' + error.message);
      throw new InternalServerErrorException('Failed to fetch analytics data');
    }

    const allOrders = orders || [];
    
    // Filter for completed/printed orders
    const completedOrders = allOrders.filter(o => o.state === 'PRINTED');
    const completedOrdersCount = completedOrders.length;
    
    // Filter for active orders
    const activeOrders = allOrders.filter(o => o.state !== 'PRINTED' && o.state !== 'CANCELLED');
    const activeOrdersCount = activeOrders.length;

    // Calculate total revenue from completed orders
    const totalRevenue = completedOrders.reduce((sum, order) => sum + (Number(order.total) || 0), 0);

    // Calculate unique customers
    const uniqueCustomers = new Set(allOrders.map(o => o.client_id)).size;

    // Aggregate orders over time (for the line chart) using actual order dates
    const volumeMap = new Map<string, number>();
    allOrders.forEach(order => {
      const dateObj = new Date(order.created_at);
      const dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: '2-digit' }); // e.g. "Apr 05"
      volumeMap.set(dateStr, (volumeMap.get(dateStr) || 0) + 1);
    });

    // Convert map to array sorted by date (basic chronological sort assumes DB returned them recent first, but we reverse it for the chart to go left-to-right)
    const printVolumeOverTime = Array.from(volumeMap.entries())
      .map(([date, volume]) => ({ date, volume }))
      .reverse();
      
    // If no orders yet, provide empty data so the chart doesn't break
    if (printVolumeOverTime.length === 0) {
      printVolumeOverTime.push({ date: 'Today', volume: 0 });
    }

    // Recent 3 orders for the "Recent Print Jobs" section
    const recentOrders = allOrders.slice(0, 3).map(order => {
      let fileName = 'Unknown File';
      if (order.assets && order.assets.length > 0 && order.assets[0].file_url) {
        const urlParts = order.assets[0].file_url.split('/');
        let rawName = decodeURIComponent(urlParts[urlParts.length - 1]);
        const match = rawName.match(/-\d{13}-(.+)$/);
        fileName = match ? match[1] : rawName;
      }
      return {
        id: order.id,
        fileName,
        state: order.state,
      };
    });

    return {
      totalRevenue: totalRevenue.toFixed(2),
      uniqueCustomers,
      completedOrdersCount,
      activeOrdersCount,
      printVolumeOverTime,
      recentOrders,
    };
  }
}
