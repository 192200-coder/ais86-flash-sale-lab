export interface Product {
  id: string;
  name: string;
  description: string;
  category: string;
  price_cents: number;
  original_price_cents: number;
  stock: number;
  image: string;
}

export interface Campaign {
  name: string;
  ends_at: string;
  currency: string;
}

export interface Catalog {
  items: Product[];
  campaign: Campaign;
}

export type NotificationStatus = 'pending' | 'sent' | 'failed';

export interface OrderLine {
  product_id: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
}

export interface Order {
  id: string;
  status: 'confirmed';
  notification_status: NotificationStatus;
  items: OrderLine[];
  total_cents: number;
  created_at: string;
}

export type BillingStatus = 'pending' | 'issued' | 'failed';

/** Semana 11: estado local de facturación, independiente de la notificación. */
export interface Billing {
  status: BillingStatus;
  invoice_number: string | null;
}

/** Semana 12: sesión de Supabase Auth (a través de la API de S09). */
export type Role = 'admin' | 'cliente';

export interface AuthUser {
  id: string;
  email: string;
  full_name: string;
  role: Role;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: AuthUser;
}

export interface Customer {
  email: string;
  full_name: string;
}

export interface OrderSummary {
  id: string;
  created_at: string;
  total_cents: number;
  notification_status: NotificationStatus;
  items: Array<{ name: string; quantity: number }>;
  customer: Customer | null;
  billing: {
    status: BillingStatus;
    invoice_number: string | null;
    error: string | null;
    attempts: number;
  } | null;
  timeline: TimelineStep[];
}

export type TimelineState = 'done' | 'pending' | 'failed' | 'none';

export interface TimelineStep {
  step: 'confirmed' | 'notification' | 'invoice';
  state: TimelineState;
  at: string | null;
  detail: string | null;
}

export interface PurchasePage {
  items: OrderSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminSummary {
  orders: number;
  sales_cents: number;
  invoices: { issued: number; pending: number; failed: number };
  customers: number;
  orders_without_account: number;
}

export interface InvoiceLine {
  name: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
}

export interface Invoice {
  invoice_id: string;
  invoice_number: string;
  issued_at: string;
  verified: boolean;
  issuer: { name: string; client_id: string | null };
  customer: Customer | null;
  order: { id: string; created_at: string };
  items: InvoiceLine[];
  totals: { taxable_cents: number; igv_cents: number; igv_rate: number; total_cents: number };
  note: string;
}

export interface CartLine {
  productId: string;
  quantity: number;
}

export interface OrderRequestBody {
  items: Array<{
    product_id: string;
    quantity: number;
  }>;
}
