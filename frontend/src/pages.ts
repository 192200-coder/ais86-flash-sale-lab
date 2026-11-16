/**
 * Semana 12: páginas de compras con rutas por hash.
 *   #mis-compras        -> compras del usuario con su seguimiento (requiere sesión)
 *   #admin              -> todas las compras, resumen y reintentos (requiere rol admin)
 *   #factura/<pedido>   -> factura imprimible (titular de la compra o admin)
 * Cualquier otro hash muestra la tienda. Las guardas de aquí son solo de interfaz:
 * la API vuelve a comprobar sesión y rol en cada petición.
 */
import {
  ApiError,
  fetchAdminOrders,
  fetchAdminSummary,
  fetchInvoice,
  fetchMyOrders,
  isAuthError,
  retryBillingRequest
} from './api';
import type { BillingFilter } from './api';
import {
  adminPage,
  guardPage,
  invoiceLoadingPage,
  invoicePage,
  invoiceProblemPage,
  purchasesPage
} from './pageViews';
import type { InvoiceProblem, PageState } from './pageViews';
import { el } from './dom';
import { currentSession, expireSession, onSessionChange } from './session';
import type { Elements } from './shell';
import type { AdminSummary, Invoice, OrderSummary } from './types';

export interface PageDeps {
  openAuth: () => void;
  openReceipt: (orderId: string) => void;
  toast: (message: string, tone?: 'info' | 'warn') => void;
}

type Route =
  | { kind: 'store' }
  | { kind: 'purchases' }
  | { kind: 'admin' }
  | { kind: 'invoice'; orderId: string };

const purchasesPageSize = 10;
const adminPageSize = 20;
const refreshMs = 4000;
const maxRefreshes = 15;

let ui: Elements;
let deps: PageDeps;
let route: Route = { kind: 'store' };
let lastList: 'purchases' | 'admin' = 'purchases';
let baseTitle = document.title;
let token = 0;
let refreshTimer: number | null = null;
let refreshCount = 0;

interface ListData {
  state: PageState;
  error: string;
  orders: OrderSummary[];
  total: number;
  filter: BillingFilter;
  loadingMore: boolean;
  refreshing: boolean;
}

const purchases: ListData = emptyList();
const admin: ListData & { summary: AdminSummary | null; search: string; busyOrderId: string | null } = {
  ...emptyList(),
  summary: null,
  search: '',
  busyOrderId: null
};
let invoice: { state: 'loading' | 'ready' | 'problem'; data: Invoice | null; problem: InvoiceProblem | null; tries: number } = {
  state: 'loading',
  data: null,
  problem: null,
  tries: 0
};

function emptyList(): ListData {
  return { state: 'loading', error: '', orders: [], total: 0, filter: 'all', loadingMore: false, refreshing: false };
}

export function isPageRoute(): boolean {
  return parseRoute(window.location.hash).kind !== 'store';
}

export function initPages(elements: Elements, dependencies: PageDeps): void {
  ui = elements;
  deps = dependencies;
  baseTitle = document.title;
  window.addEventListener('hashchange', () => applyRoute(true));
  ui.pageView.addEventListener('click', onClick);
  ui.pageView.addEventListener('submit', onSubmit);
  onSessionChange(() => {
    updateNav();
    if (route.kind !== 'store') {
      applyRoute(false);
    }
  });
  updateNav();
  applyRoute(false);
}

function parseRoute(hash: string): Route {
  if (hash === '#mis-compras') {
    return { kind: 'purchases' };
  }
  if (hash === '#admin') {
    return { kind: 'admin' };
  }
  const match = /^#factura\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(hash);
  if (match) {
    return { kind: 'invoice', orderId: match[1].toLowerCase() };
  }
  return { kind: 'store' };
}

function updateNav(): void {
  const session = currentSession();
  ui.purchasesLink.hidden = !session;
  ui.adminLink.hidden = session?.user.role !== 'admin';
  const current = route.kind;
  ui.purchasesLink.toggleAttribute('aria-current', current === 'purchases');
  ui.adminLink.toggleAttribute('aria-current', current === 'admin');
  if (current === 'purchases') ui.purchasesLink.setAttribute('aria-current', 'page');
  if (current === 'admin') ui.adminLink.setAttribute('aria-current', 'page');
}

function applyRoute(fromHashChange: boolean): void {
  stopRefresh();
  token += 1;
  route = parseRoute(window.location.hash);
  updateNav();

  if (route.kind === 'store') {
    ui.pageView.hidden = true;
    ui.pageView.replaceChildren();
    ui.storeView.hidden = false;
    document.title = baseTitle;
    if (fromHashChange && window.location.hash.length > 1) {
      const target = document.getElementById(window.location.hash.slice(1));
      window.setTimeout(() => target?.scrollIntoView({ block: 'start' }), 0);
    }
    return;
  }

  ui.storeView.hidden = true;
  ui.pageView.hidden = false;
  window.scrollTo({ top: 0 });
  const session = currentSession();
  if (!session) {
    setTitle('Inicia sesión');
    show(guardPage('signin', 'Tus compras'));
    return;
  }
  if (route.kind === 'admin' && session.user.role !== 'admin') {
    setTitle('Administración');
    show(guardPage('forbidden', 'Administración'));
    return;
  }
  if (route.kind === 'purchases') {
    lastList = 'purchases';
    setTitle('Mis compras');
    Object.assign(purchases, { ...emptyList(), filter: purchases.filter });
    void loadPurchases(false);
  } else if (route.kind === 'admin') {
    lastList = 'admin';
    setTitle('Administración');
    Object.assign(admin, { ...emptyList(), filter: admin.filter, summary: null, search: admin.search, busyOrderId: null });
    void loadAdmin(false);
  } else {
    setTitle('Factura');
    invoice = { state: 'loading', data: null, problem: null, tries: 0 };
    void loadInvoice(route.orderId);
  }
  window.requestAnimationFrame(() => document.getElementById('page-title')?.focus({ preventScroll: true }));
}

function setTitle(title: string): void {
  document.title = `${title} · FLASH`;
}

function show(nodes: Node[]): void {
  const section = el('section', { class: 'page shell', 'aria-labelledby': 'page-title' });
  section.append(...nodes);
  ui.pageView.replaceChildren(section);
}

function render(): void {
  if (route.kind === 'purchases') {
    show(purchasesPage(purchases));
  } else if (route.kind === 'admin') {
    show(adminPage(admin));
  } else if (route.kind === 'invoice') {
    const back = lastList === 'admin' && currentSession()?.user.role === 'admin' ? '#admin' : '#mis-compras';
    if (invoice.state === 'ready' && invoice.data) {
      show(invoicePage(invoice.data, back));
    } else if (invoice.state === 'problem' && invoice.problem) {
      show(invoiceProblemPage(invoice.problem, back));
    } else {
      show(invoiceLoadingPage(back));
    }
  }
}

function handleAuthError(error: unknown): boolean {
  if (isAuthError(error)) {
    expireSession();
    return true;
  }
  return false;
}

// --- Mis compras -----------------------------------------------------------------------

async function loadPurchases(append: boolean, silent = false): Promise<void> {
  const current = token;
  if (append) {
    purchases.loadingMore = true;
  } else if (!silent) {
    purchases.state = 'loading';
  }
  purchases.refreshing = silent;
  render();
  try {
    const offset = append ? purchases.orders.length : 0;
    const limit = silent ? Math.min(100, Math.max(purchasesPageSize, purchases.orders.length)) : purchasesPageSize;
    const page = await fetchMyOrders(purchases.filter, offset, limit);
    if (current !== token) return;
    purchases.orders = append ? [...purchases.orders, ...page.items] : page.items;
    purchases.total = page.total;
    purchases.state = 'ready';
  } catch (error) {
    if (current !== token || handleAuthError(error)) return;
    if (!silent) {
      purchases.state = 'error';
      purchases.error = 'No pudimos cargar tus compras. Inténtalo de nuevo.';
    }
  }
  purchases.loadingMore = false;
  purchases.refreshing = false;
  render();
  scheduleRefresh(purchases.orders, () => loadPurchases(false, true));
}

// --- Administración --------------------------------------------------------------------

async function loadAdmin(append: boolean, silent = false): Promise<void> {
  const current = token;
  if (append) {
    admin.loadingMore = true;
  } else if (!silent) {
    admin.state = 'loading';
  }
  admin.refreshing = silent;
  render();
  try {
    const offset = append ? admin.orders.length : 0;
    const limit = silent ? Math.min(200, Math.max(adminPageSize, admin.orders.length)) : adminPageSize;
    const [page, summary] = await Promise.all([
      fetchAdminOrders(admin.filter, admin.search, offset, limit),
      append ? Promise.resolve(admin.summary) : fetchAdminSummary()
    ]);
    if (current !== token) return;
    admin.orders = append ? [...admin.orders, ...page.items] : page.items;
    admin.total = page.total;
    admin.summary = summary;
    admin.state = 'ready';
  } catch (error) {
    if (current !== token || handleAuthError(error)) return;
    if (!silent) {
      admin.state = 'error';
      admin.error =
        error instanceof ApiError && error.code === 'FORBIDDEN'
          ? 'Tu cuenta no tiene rol de administrador.'
          : 'No pudimos cargar las compras. Inténtalo de nuevo.';
    }
  }
  admin.loadingMore = false;
  admin.refreshing = false;
  render();
  scheduleRefresh(admin.orders, () => loadAdmin(false, true));
}

async function retry(orderId: string): Promise<void> {
  if (admin.busyOrderId) return;
  admin.busyOrderId = orderId;
  render();
  try {
    await retryBillingRequest(orderId);
    deps.toast('Facturación reenviada: el worker la emite con la misma clave, sin duplicar.');
  } catch (error) {
    if (handleAuthError(error)) return;
    deps.toast('No se pudo reintentar la facturación.', 'warn');
  }
  admin.busyOrderId = null;
  refreshCount = 0;
  await loadAdmin(false, true);
}

// --- Factura ---------------------------------------------------------------------------

async function loadInvoice(orderId: string): Promise<void> {
  const current = token;
  render();
  try {
    const data = await fetchInvoice(orderId);
    if (current !== token) return;
    invoice = { state: 'ready', data, problem: null, tries: invoice.tries };
    setTitle(`Factura ${data.invoice_number}`);
  } catch (error) {
    if (current !== token || handleAuthError(error)) return;
    let problem: InvoiceProblem = { kind: 'error', message: 'No pudimos cargar la factura. Inténtalo de nuevo.' };
    if (error instanceof ApiError && error.code === 'INVOICE_NOT_ISSUED') {
      const details = typeof error.details === 'object' && error.details !== null ? (error.details as Record<string, unknown>) : {};
      problem = {
        kind: 'not-issued',
        billingStatus: typeof details.billing_status === 'string' ? details.billing_status : null,
        error: typeof details.error === 'string' ? details.error : null
      };
    } else if (error instanceof ApiError && error.code === 'NOT_FOUND') {
      problem = { kind: 'not-found' };
    }
    invoice = { state: 'problem', data: null, problem, tries: invoice.tries + 1 };
    // Recién comprada: la factura se emite en segundos; se reintenta sola unas veces.
    if (problem.kind === 'not-issued' && problem.billingStatus === 'pending' && invoice.tries < 10) {
      refreshTimer = window.setTimeout(() => void loadInvoice(orderId), 3000);
    }
  }
  render();
}

// --- Refresco de estados pendientes ----------------------------------------------------

function hasPending(orders: readonly OrderSummary[]): boolean {
  return orders.some((order) => order.timeline.some((step) => step.state === 'pending'));
}

function scheduleRefresh(orders: readonly OrderSummary[], reload: () => Promise<void>): void {
  stopRefresh();
  if (!hasPending(orders) || refreshCount >= maxRefreshes) {
    return;
  }
  refreshTimer = window.setTimeout(() => {
    refreshCount += 1;
    void reload();
  }, refreshMs);
}

function stopRefresh(): void {
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

// --- Eventos ---------------------------------------------------------------------------

function onClick(event: MouseEvent): void {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLElement>('[data-page-action]');
  if (!button) return;
  const action = button.dataset.pageAction;
  const orderId = button.dataset.orderId;
  switch (action) {
    case 'signin':
      deps.openAuth();
      break;
    case 'print':
      window.print();
      break;
    case 'receipt':
      if (orderId) deps.openReceipt(orderId);
      break;
    case 'retry':
      if (orderId) void retry(orderId);
      break;
    case 'more':
      if (route.kind === 'purchases') void loadPurchases(true);
      if (route.kind === 'admin') void loadAdmin(true);
      break;
    case 'reload':
      refreshCount = 0;
      if (route.kind === 'invoice') {
        invoice = { state: 'loading', data: null, problem: null, tries: 0 };
        void loadInvoice(route.orderId);
      } else if (route.kind === 'purchases') {
        void loadPurchases(false);
      } else if (route.kind === 'admin') {
        void loadAdmin(false);
      }
      break;
    case 'filter': {
      const value = button.dataset.filter;
      if (value !== 'all' && value !== 'issued' && value !== 'pending' && value !== 'failed') break;
      refreshCount = 0;
      token += 1;
      if (route.kind === 'purchases') {
        purchases.filter = value;
        purchases.orders = [];
        void loadPurchases(false);
      } else if (route.kind === 'admin') {
        admin.filter = value;
        admin.orders = [];
        void loadAdmin(false);
      }
      break;
    }
  }
}

function onSubmit(event: SubmitEvent): void {
  if (!(event.target instanceof HTMLFormElement) || !event.target.matches('[data-admin-search]')) return;
  event.preventDefault();
  const value = new FormData(event.target).get('q');
  admin.search = typeof value === 'string' ? value.trim().slice(0, 80) : '';
  admin.orders = [];
  refreshCount = 0;
  token += 1;
  void loadAdmin(false);
}
