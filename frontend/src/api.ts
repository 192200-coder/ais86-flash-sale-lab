import type {
  AdminSummary,
  AuthUser,
  Billing,
  BillingStatus,
  Catalog,
  Campaign,
  Customer,
  Invoice,
  NotificationStatus,
  Order,
  OrderLine,
  OrderSummary,
  Product,
  PurchasePage,
  Session,
  TimelineStep
} from './types';

const defaultTimeoutMs = 12000;

/** Semana 12: session.ts registra aquí cómo obtener un access token vigente. */
type TokenProvider = () => Promise<string | null>;
let tokenProvider: TokenProvider = async () => null;

export function setTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(code: string, status: number, message: string, details: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Envía `Authorization: Bearer <token>` si hay sesión. */
  auth?: boolean;
  /** Acepta respuestas sin cuerpo (204). */
  allowEmpty?: boolean;
  /** Token explícito (logout). */
  bearer?: string;
}

interface RawResponse {
  payload: unknown;
  status: number;
}

interface FriendlyError {
  code: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}

function isNotificationStatus(value: unknown): value is NotificationStatus {
  return value === 'pending' || value === 'sent' || value === 'failed';
}

function invalidResponse(): ApiError {
  return new ApiError('RESPONSE_INVALID', 0, 'La respuesta del servidor no es válida.');
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidResponse();
  }
  return value;
}

function readInteger(record: Record<string, unknown>, key: string, minimum: number): number {
  const value = record[key];
  if (!isInteger(value) || value < minimum) {
    throw invalidResponse();
  }
  return value;
}

function parseProduct(value: unknown): Product {
  if (!isRecord(value)) {
    throw invalidResponse();
  }
  const image = readString(value, 'image');
  if (!/^\/assets\/[a-z0-9-]+\.svg$/i.test(image)) {
    throw invalidResponse();
  }
  return {
    id: readString(value, 'id'),
    name: readString(value, 'name'),
    description: readString(value, 'description'),
    category: readString(value, 'category'),
    price_cents: readInteger(value, 'price_cents', 0),
    original_price_cents: readInteger(value, 'original_price_cents', 0),
    stock: readInteger(value, 'stock', 0),
    image
  };
}

function parseCampaign(value: unknown): Campaign {
  if (!isRecord(value)) {
    throw invalidResponse();
  }
  const endsAt = readString(value, 'ends_at');
  if (Number.isNaN(new Date(endsAt).getTime())) {
    throw invalidResponse();
  }
  return {
    name: readString(value, 'name'),
    ends_at: endsAt,
    currency: readString(value, 'currency')
  };
}

function parseCatalog(value: unknown): Catalog {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw invalidResponse();
  }
  const items = value.items.map(parseProduct);
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) {
    throw invalidResponse();
  }
  return {
    items,
    campaign: parseCampaign(value.campaign)
  };
}

function parseOrderLine(value: unknown): OrderLine {
  if (!isRecord(value)) {
    throw invalidResponse();
  }
  return {
    product_id: readString(value, 'product_id'),
    name: readString(value, 'name'),
    quantity: readInteger(value, 'quantity', 1),
    unit_price_cents: readInteger(value, 'unit_price_cents', 0)
  };
}

function parseOrder(value: unknown): Order {
  if (!isRecord(value)) {
    throw invalidResponse();
  }
  if (value.status !== 'confirmed' || !isNotificationStatus(value.notification_status)) {
    throw invalidResponse();
  }
  if (!Array.isArray(value.items) || value.items.length === 0) {
    throw invalidResponse();
  }
  const createdAt = readString(value, 'created_at');
  if (Number.isNaN(new Date(createdAt).getTime())) {
    throw invalidResponse();
  }
  return {
    id: readString(value, 'id'),
    status: 'confirmed',
    notification_status: value.notification_status,
    items: value.items.map(parseOrderLine),
    total_cents: readInteger(value, 'total_cents', 0),
    created_at: createdAt
  };
}

async function request(path: string, options: RequestOptions = {}): Promise<RawResponse> {
  const controller = new AbortController();
  const externalSignal = options.signal;
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? defaultTimeoutMs);

  const forwardAbort = (): void => {
    controller.abort();
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers
    };
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const token = options.bearer ?? (options.auth ? await tokenProvider() : null);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body,
      cache: 'no-store',
      credentials: 'same-origin',
      mode: 'same-origin',
      signal: controller.signal
    });

    const text = await response.text();
    let payload: unknown = null;

    if (text.length > 0) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        throw new ApiError('RESPONSE_INVALID', response.status, 'La respuesta del servidor no es válida.');
      }
    }

    if (!response.ok) {
      if (isRecord(payload) && isRecord(payload.error)) {
        const error = payload.error;
        const code = typeof error.code === 'string' ? error.code : 'HTTP_ERROR';
        const message =
          typeof error.message === 'string' ? error.message : 'No se pudo completar la solicitud.';
        throw new ApiError(code, response.status, message, error.details ?? null);
      }
      throw new ApiError(
        'HTTP_ERROR',
        response.status,
        'No se pudo completar la solicitud.',
        null
      );
    }

    if (text.length === 0 && !options.allowEmpty) {
      throw new ApiError('RESPONSE_INVALID', response.status, 'La respuesta del servidor está vacía.');
    }

    return { payload, status: response.status };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (externalSignal?.aborted) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw new DOMException('Aborted', 'AbortError');
    }
    if (timedOut || controller.signal.aborted) {
      throw new ApiError('NETWORK_TIMEOUT', 0, 'La solicitud tardó demasiado.', null);
    }
    throw new ApiError('NETWORK_ERROR', 0, 'No se pudo conectar con el servidor.', null);
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export async function fetchCatalog(signal?: AbortSignal): Promise<Catalog> {
  const response = await request('/api/v1/products', { signal });
  return parseCatalog(response.payload);
}

export async function createOrder(
  items: Array<{ product_id: string; quantity: number }>,
  idempotencyKey: string,
  signal?: AbortSignal
): Promise<Order> {
  const response = await request('/api/v1/orders', {
    method: 'POST',
    body: { items },
    headers: { 'Idempotency-Key': idempotencyKey },
    signal,
    auth: true
  });
  if (response.status !== 201) {
    throw new ApiError(
      'RESPONSE_INVALID',
      response.status,
      'El servidor no confirmó el pedido con el estado esperado.',
      null
    );
  }
  return parseOrder(response.payload);
}

export async function fetchOrder(id: string, signal?: AbortSignal): Promise<Order> {
  const response = await request(`/api/v1/orders/${encodeURIComponent(id)}`, { signal });
  return parseOrder(response.payload);
}

export async function fetchBilling(id: string, signal?: AbortSignal): Promise<Billing> {
  const response = await request(`/api/v1/orders/${encodeURIComponent(id)}/billing`, { signal });
  const payload = response.payload;
  const status = isRecord(payload) ? payload.status : null;
  if (status !== 'pending' && status !== 'issued' && status !== 'failed') {
    throw new ApiError('INVALID_RESPONSE', response.status, 'Respuesta de facturación no válida');
  }
  const number = isRecord(payload) && typeof payload.invoice_number === 'string' ? payload.invoice_number : null;
  return { status, invoice_number: number };
}

// --- Semana 12: autenticación, cuenta y administración ---------------------------------

function parseUser(value: unknown): AuthUser {
  if (!isRecord(value)) {
    throw invalidResponse();
  }
  const role = value.role === 'admin' ? 'admin' : 'cliente';
  return {
    id: readString(value, 'id'),
    email: readString(value, 'email'),
    full_name: readString(value, 'full_name'),
    role
  };
}

function parseSession(value: unknown): Session {
  if (!isRecord(value)) {
    throw invalidResponse();
  }
  const expiresIn = readInteger(value, 'expires_in', 1);
  return {
    accessToken: readString(value, 'access_token'),
    refreshToken: readString(value, 'refresh_token'),
    expiresAt: Date.now() + expiresIn * 1000,
    user: parseUser(value.user)
  };
}

function isBillingStatus(value: unknown): value is BillingStatus {
  return value === 'pending' || value === 'issued' || value === 'failed';
}

function parseCustomer(value: unknown): Customer | null {
  if (!isRecord(value)) {
    return null;
  }
  return { email: readString(value, 'email'), full_name: readString(value, 'full_name') };
}

function parseSummary(value: unknown): OrderSummary {
  if (!isRecord(value) || !Array.isArray(value.items) || !isNotificationStatus(value.notification_status)) {
    throw invalidResponse();
  }
  const billing = isRecord(value.billing) && isBillingStatus(value.billing.status)
    ? {
        status: value.billing.status,
        invoice_number: typeof value.billing.invoice_number === 'string' ? value.billing.invoice_number : null,
        error: typeof value.billing.error === 'string' ? value.billing.error : null,
        attempts: isInteger(value.billing.attempts) ? value.billing.attempts : 0
      }
    : null;
  return {
    id: readString(value, 'id'),
    created_at: readString(value, 'created_at'),
    total_cents: readInteger(value, 'total_cents', 0),
    notification_status: value.notification_status,
    items: value.items.filter(isRecord).map((item) => ({
      name: typeof item.name === 'string' ? item.name : 'Producto',
      quantity: isInteger(item.quantity) ? item.quantity : 1
    })),
    customer: parseCustomer(value.customer),
    billing,
    timeline: Array.isArray(value.timeline) ? value.timeline.filter(isRecord).map(parseStep) : []
  };
}

function parseStep(value: Record<string, unknown>): TimelineStep {
  const step = value.step === 'notification' || value.step === 'invoice' ? value.step : 'confirmed';
  const state =
    value.state === 'done' || value.state === 'failed' || value.state === 'none' ? value.state : 'pending';
  return {
    step,
    state,
    at: typeof value.at === 'string' ? value.at : null,
    detail: typeof value.detail === 'string' ? value.detail : null
  };
}

function parsePage(value: unknown): PurchasePage {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw invalidResponse();
  }
  return {
    items: value.items.map(parseSummary),
    total: readInteger(value, 'total', 0),
    limit: readInteger(value, 'limit', 1),
    offset: readInteger(value, 'offset', 0)
  };
}

export type BillingFilter = BillingStatus | 'all';

function pageQuery(params: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '' && value !== 'all') {
      query.set(key, String(value));
    }
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

export async function loginRequest(email: string, password: string): Promise<Session> {
  const response = await request('/api/v1/auth/login', { method: 'POST', body: { email, password } });
  return parseSession(response.payload);
}

/** Devuelve la sesión, o `null` si Supabase pide confirmar el correo antes de iniciar sesión. */
export async function signupRequest(fullName: string, email: string, password: string): Promise<Session | null> {
  const response = await request('/api/v1/auth/signup', {
    method: 'POST',
    body: { full_name: fullName, email, password }
  });
  if (response.status === 202) {
    return null;
  }
  return parseSession(response.payload);
}

export async function refreshRequest(refreshToken: string): Promise<Session> {
  const response = await request('/api/v1/auth/refresh', {
    method: 'POST',
    body: { refresh_token: refreshToken }
  });
  return parseSession(response.payload);
}

export async function logoutRequest(accessToken: string): Promise<void> {
  await request('/api/v1/auth/logout', { method: 'POST', bearer: accessToken, allowEmpty: true });
}

export async function fetchMyOrders(
  filter: BillingFilter,
  offset: number,
  limit: number,
  signal?: AbortSignal
): Promise<PurchasePage> {
  const response = await request(`/api/v1/me/orders${pageQuery({ billing: filter, offset, limit })}`, {
    signal,
    auth: true
  });
  return parsePage(response.payload);
}

export async function fetchAdminOrders(
  filter: BillingFilter,
  search: string,
  offset: number,
  limit: number,
  signal?: AbortSignal
): Promise<PurchasePage> {
  const response = await request(
    `/api/v1/admin/orders${pageQuery({ billing: filter, q: search.trim().slice(0, 80), offset, limit })}`,
    { signal, auth: true }
  );
  return parsePage(response.payload);
}

export async function fetchAdminSummary(signal?: AbortSignal): Promise<AdminSummary> {
  const response = await request('/api/v1/admin/summary', { signal, auth: true });
  const value = response.payload;
  if (!isRecord(value) || !isRecord(value.invoices)) {
    throw invalidResponse();
  }
  return {
    orders: readInteger(value, 'orders', 0),
    sales_cents: readInteger(value, 'sales_cents', 0),
    invoices: {
      issued: readInteger(value.invoices, 'issued', 0),
      pending: readInteger(value.invoices, 'pending', 0),
      failed: readInteger(value.invoices, 'failed', 0)
    },
    customers: readInteger(value, 'customers', 0),
    orders_without_account: readInteger(value, 'orders_without_account', 0)
  };
}

export async function fetchInvoice(orderId: string, signal?: AbortSignal): Promise<Invoice> {
  const response = await request(`/api/v1/orders/${encodeURIComponent(orderId)}/invoice`, { signal, auth: true });
  const value = response.payload;
  if (!isRecord(value) || !isRecord(value.issuer) || !isRecord(value.order) || !isRecord(value.totals) || !Array.isArray(value.items)) {
    throw invalidResponse();
  }
  const rate = value.totals.igv_rate;
  return {
    invoice_id: readString(value, 'invoice_id'),
    invoice_number: readString(value, 'invoice_number'),
    issued_at: readString(value, 'issued_at'),
    verified: value.verified === true,
    issuer: {
      name: readString(value.issuer, 'name'),
      client_id: typeof value.issuer.client_id === 'string' ? value.issuer.client_id : null
    },
    customer: parseCustomer(value.customer),
    order: { id: readString(value.order, 'id'), created_at: readString(value.order, 'created_at') },
    items: value.items.filter(isRecord).map((item) => ({
      name: typeof item.name === 'string' ? item.name : 'Producto',
      quantity: isInteger(item.quantity) ? item.quantity : 0,
      unit_price_cents: isInteger(item.unit_price_cents) ? item.unit_price_cents : 0,
      line_total_cents: isInteger(item.line_total_cents) ? item.line_total_cents : 0
    })),
    totals: {
      taxable_cents: readInteger(value.totals, 'taxable_cents', 0),
      igv_cents: readInteger(value.totals, 'igv_cents', 0),
      igv_rate: typeof rate === 'number' ? rate : 0.18,
      total_cents: readInteger(value.totals, 'total_cents', 0)
    },
    note: typeof value.note === 'string' ? value.note : ''
  };
}

export async function retryBillingRequest(orderId: string): Promise<void> {
  await request(`/api/v1/admin/orders/${encodeURIComponent(orderId)}/billing/retry`, {
    method: 'POST',
    auth: true
  });
}

export async function fetchCustomer(orderId: string, signal?: AbortSignal): Promise<Customer> {
  const response = await request(`/api/v1/orders/${encodeURIComponent(orderId)}/customer`, {
    signal,
    auth: true
  });
  const customer = parseCustomer(response.payload);
  if (!customer) {
    throw invalidResponse();
  }
  return customer;
}

export function isAuthError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'AUTH_REQUIRED' || error.code === 'INVALID_TOKEN' || error.code === 'SESSION_EXPIRED')
  );
}

export function authErrorMessage(error: unknown, mode: 'login' | 'signup'): string {
  const code = error instanceof ApiError ? error.code : 'UNKNOWN';
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return 'Correo o contraseña incorrectos.';
    case 'EMAIL_NOT_CONFIRMED':
      return 'Confirma tu correo antes de iniciar sesión (revisa tu bandeja de entrada).';
    case 'USER_EXISTS':
      return 'Ya existe una cuenta con ese correo. Inicia sesión.';
    case 'WEAK_PASSWORD':
      return 'La contraseña es muy débil. Usa al menos 8 caracteres combinando letras y números.';
    case 'VALIDATION_ERROR':
      return mode === 'signup'
        ? 'Revisa los datos: nombre (2 a 80 caracteres), un correo válido y una contraseña de 8 a 72 caracteres.'
        : 'Revisa el correo y la contraseña.';
    case 'SIGNUP_DISABLED':
      return 'El registro está desactivado. Pide una cuenta al administrador.';
    case 'RATE_LIMITED':
      return 'Demasiados intentos. Espera un minuto y vuelve a intentarlo.';
    case 'AUTH_NOT_CONFIGURED':
      return 'El inicio de sesión no está configurado en el servidor (faltan SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY).';
    case 'AUTH_UNAVAILABLE':
    case 'NETWORK_ERROR':
    case 'NETWORK_TIMEOUT':
      return 'No pudimos contactar el servicio de autenticación. Inténtalo de nuevo.';
    default:
      return 'No pudimos completar la operación. Inténtalo de nuevo.';
  }
}

export function friendlyError(error: unknown, context: 'catalog' | 'create' | 'order'): FriendlyError {
  const code = error instanceof ApiError ? error.code : 'UNKNOWN';

  if (context === 'catalog') {
    if (code === 'NETWORK_TIMEOUT') {
      return {
        code,
        message: 'El catálogo tardó demasiado en responder. Revisa que la API esté disponible e inténtalo de nuevo.'
      };
    }
    if (code === 'NETWORK_ERROR') {
      return {
        code,
        message: 'No pudimos conectar con el catálogo. Revisa tu conexión e inténtalo de nuevo.'
      };
    }
    if (code === 'RESPONSE_INVALID') {
      return { code, message: 'El catálogo respondió con datos que no pudimos leer.' };
    }
    return { code, message: 'No pudimos cargar el catálogo. Inténtalo de nuevo.' };
  }

  if (context === 'create') {
    if (code === 'AUTH_REQUIRED' || code === 'INVALID_TOKEN' || code === 'SESSION_EXPIRED') {
      return {
        code,
        message: 'Tu sesión no es válida o expiró. Inicia sesión de nuevo para confirmar el pedido; tu carrito sigue intacto.'
      };
    }
    if (code === 'OUT_OF_STOCK') {
      return {
        code,
        message: 'La disponibilidad cambió y no hay stock suficiente. Actualizamos el catálogo; revisa tu carrito.'
      };
    }
    if (code === 'IDEMPOTENCY_CONFLICT') {
      return {
        code,
        message: 'El intento anterior no coincide con este carrito. Confirma de nuevo para crear un pedido nuevo.'
      };
    }
    if (code === 'VALIDATION_ERROR') {
      return {
        code,
        message: 'El pedido no pasó la validación del servidor. Revisa las cantidades y vuelve a intentarlo.'
      };
    }
    if (code === 'RATE_LIMITED') {
      return {
        code,
        message: 'Hay demasiadas solicitudes. Espera unos segundos y vuelve a intentarlo.'
      };
    }
    if (code === 'NETWORK_TIMEOUT') {
      return {
        code,
        message: 'La confirmación tardó demasiado. Tu carrito sigue intacto; reintenta y no se duplicará el pedido.'
      };
    }
    if (code === 'NETWORK_ERROR') {
      return {
        code,
        message: 'No pudimos conectar para confirmar. Tu carrito sigue intacto; reintenta y no se duplicará el pedido.'
      };
    }
    if (code === 'RESPONSE_INVALID') {
      return {
        code,
        message: 'No pudimos leer la confirmación. Reintenta para recuperar el mismo pedido.'
      };
    }
    return {
      code,
      message: 'El servidor no pudo crear el pedido. Tu carrito sigue intacto; inténtalo de nuevo.'
    };
  }

  if (code === 'NOT_FOUND') {
    return { code, message: 'No encontramos un pedido con ese ID.' };
  }
  if (code === 'NETWORK_TIMEOUT') {
    return { code, message: 'La consulta tardó demasiado. Inténtalo de nuevo.' };
  }
  if (code === 'NETWORK_ERROR') {
    return { code, message: 'No pudimos conectar para consultar el pedido. Inténtalo de nuevo.' };
  }
  if (code === 'RESPONSE_INVALID') {
    return { code, message: 'El servidor respondió con datos que no pudimos leer.' };
  }
  return { code, message: 'No pudimos consultar el pedido. Inténtalo de nuevo.' };
}
