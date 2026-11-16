/**
 * Semana 12: vistas de página completa — "Mis compras", "Administración" y la factura.
 * Solo construyen DOM a partir de datos; la lógica vive en pages.ts.
 */
import type { BillingFilter } from './api';
import { el, icon } from './dom';
import type { IconName } from './dom';
import { formatDateTime, formatMoney } from './format';
import type { AdminSummary, Invoice, OrderSummary, TimelineStep } from './types';

export type PageState = 'loading' | 'ready' | 'error';

const filterLabels: Array<[BillingFilter, string]> = [
  ['all', 'Todas'],
  ['issued', 'Facturadas'],
  ['pending', 'Pendientes'],
  ['failed', 'Con problema']
];

function pageButton(action: string, label: string, iconName: IconName, className = 'button button-secondary'): HTMLButtonElement {
  const button = el('button', { type: 'button', class: className, 'data-page-action': action });
  button.append(icon(iconName), el('span', {}, label));
  return button;
}

function pageHead(title: string, subtitle: string, ...actions: Node[]): HTMLElement {
  return el(
    'div',
    { class: 'page-head' },
    el(
      'div',
      {},
      el('h1', { class: 'section-title', id: 'page-title', tabindex: '-1' }, title),
      el('p', { class: 'catalog-meta' }, subtitle)
    ),
    el('div', { class: 'page-head-actions' }, ...actions)
  );
}

export function shortId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

function filterChips(active: BillingFilter, disabled: boolean): HTMLElement {
  const group = el('div', { class: 'category-chips page-filters', role: 'group', 'aria-label': 'Filtrar por estado de la factura' });
  for (const [value, label] of filterLabels) {
    const button = el(
      'button',
      { type: 'button', class: 'chip chip-filter', 'data-page-action': 'filter', 'data-filter': value, 'aria-pressed': value === active ? 'true' : 'false' },
      label
    );
    button.classList.toggle('is-active', value === active);
    button.disabled = disabled;
    group.append(button);
  }
  return group;
}

function stepText(step: TimelineStep): { label: string; meta: string } {
  const when = step.at ? formatDateTime(step.at) : '';
  if (step.step === 'confirmed') {
    return { label: 'Pedido confirmado', meta: when };
  }
  if (step.step === 'notification') {
    if (step.state === 'done') return { label: 'Notificación enviada', meta: when };
    if (step.state === 'failed') return { label: 'La notificación falló', meta: 'El pedido sigue confirmado' };
    return { label: 'Notificación pendiente', meta: 'En proceso…' };
  }
  if (step.state === 'done') return { label: 'Factura emitida', meta: [step.detail ?? '', when].filter(Boolean).join(' · ') };
  if (step.state === 'failed') return { label: 'Facturación con problema', meta: `${step.detail ?? 'Error'} · pendiente de reintento` };
  if (step.state === 'none') return { label: 'Sin facturación', meta: 'Pedido anterior a la facturación' };
  return { label: 'Factura pendiente', meta: 'El microservicio la está emitiendo…' };
}

export function timelineNode(steps: readonly TimelineStep[], compact = false): HTMLElement {
  const list = el('ol', { class: compact ? 'timeline timeline-compact' : 'timeline', 'aria-label': 'Seguimiento del pedido' });
  for (const step of steps) {
    const text = stepText(step);
    const item = el(
      'li',
      { class: `timeline-step is-${step.state}`, title: compact ? `${text.label}${text.meta ? ` — ${text.meta}` : ''}` : null },
      el('span', { class: 'timeline-dot', 'aria-hidden': 'true' }, step.state === 'done' ? icon('check') : null)
    );
    if (compact) {
      item.append(el('span', { class: 'visually-hidden' }, `${text.label}. ${text.meta}`));
    } else {
      item.append(
        el('div', { class: 'timeline-copy' }, el('p', { class: 'timeline-label' }, text.label), text.meta ? el('p', { class: 'timeline-meta' }, text.meta) : null)
      );
    }
    list.append(item);
  }
  return list;
}

function itemsText(order: OrderSummary): string {
  return order.items.map((item) => `${item.quantity} × ${item.name}`).join(', ');
}

function invoiceReady(order: OrderSummary): boolean {
  return order.billing?.status === 'issued' && Boolean(order.billing.invoice_number);
}

function invoiceLink(orderId: string, small = true): HTMLAnchorElement {
  const link = el('a', { class: `button button-primary${small ? ' button-small' : ''}`, href: `#factura/${orderId}` });
  link.append(icon('copy'), el('span', {}, 'Ver factura'));
  return link;
}

function statusBlock(state: PageState, error: string, empty: Node, count: number): HTMLElement | null {
  if (state === 'loading' && count === 0) {
    return el('p', { class: 'notice-meta page-status', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Cargando…');
  }
  if (state === 'error') {
    return el('div', { class: 'alert alert-error', role: 'alert' }, icon('alert'), el('div', { class: 'alert-body' }, el('p', {}, error), pageButton('reload', 'Reintentar', 'refresh')));
  }
  if (count === 0) {
    return el('div', { class: 'page-empty' }, empty);
  }
  return null;
}

function moreButton(shown: number, total: number, busy: boolean): HTMLElement | null {
  if (shown >= total) {
    return null;
  }
  const button = pageButton('more', busy ? 'Cargando…' : `Cargar más (${total - shown} restantes)`, 'plus');
  button.disabled = busy;
  return el('div', { class: 'page-more' }, button);
}

// --- Guardas ---------------------------------------------------------------------------

export function guardPage(kind: 'signin' | 'forbidden', title: string): Node[] {
  const message =
    kind === 'signin'
      ? 'Inicia sesión para ver tus compras, su seguimiento y tus facturas.'
      : 'Esta sección es solo para cuentas con rol de administrador.';
  const box = el('div', { class: 'panel-message page-message' });
  box.append(
    el('span', { class: 'panel-message-icon' }, icon(kind === 'signin' ? 'user' : 'shield')),
    el('h2', {}, title),
    el('p', {}, message),
    kind === 'signin'
      ? pageButton('signin', 'Iniciar sesión', 'user', 'button button-primary')
      : el('a', { class: 'button button-primary', href: '#mis-compras' }, 'Ir a mis compras')
  );
  return [box];
}

// --- Mis compras -----------------------------------------------------------------------

export interface PurchasesContext {
  state: PageState;
  error: string;
  orders: readonly OrderSummary[];
  total: number;
  filter: BillingFilter;
  loadingMore: boolean;
  refreshing: boolean;
}

export function purchasesPage(context: PurchasesContext): Node[] {
  const subtitle = context.state === 'ready' || context.orders.length > 0
    ? `${context.total} ${context.total === 1 ? 'compra' : 'compras'}${context.refreshing ? ' · actualizando estados…' : ''}`
    : 'Cargando…';
  const list = el('ul', { class: 'purchase-list' });
  for (const order of context.orders) {
    const actions = el('div', { class: 'purchase-actions' });
    if (invoiceReady(order)) {
      actions.append(invoiceLink(order.id));
    }
    actions.append(
      el('button', { type: 'button', class: 'button button-secondary button-small', 'data-page-action': 'receipt', 'data-order-id': order.id }, 'Ver recibo')
    );
    list.append(
      el(
        'li',
        { class: 'purchase-card' },
        el(
          'div',
          { class: 'purchase-head' },
          el(
            'div',
            {},
            el('p', { class: 'purchase-title' }, `Pedido ${shortId(order.id)}`),
            el('p', { class: 'purchase-meta' }, formatDateTime(order.created_at))
          ),
          el('strong', { class: 'purchase-total' }, formatMoney(order.total_cents))
        ),
        el('p', { class: 'purchase-items' }, itemsText(order)),
        timelineNode(order.timeline),
        actions
      )
    );
  }
  const emptyNode = el(
    'div',
    {},
    el('p', {}, context.filter === 'all' ? 'Todavía no tienes compras.' : 'No hay compras con ese estado.'),
    el('a', { class: 'button button-primary', href: '#catalogo' }, 'Explorar el drop')
  );
  return [
    pageHead('Mis compras', subtitle, pageButton('reload', 'Actualizar', 'refresh')),
    filterChips(context.filter, context.state === 'loading'),
    statusBlock(context.state, context.error, emptyNode, context.orders.length) ?? list,
    moreButton(context.orders.length, context.total, context.loadingMore) ?? el('span')
  ];
}

// --- Administración --------------------------------------------------------------------

export interface AdminContext extends PurchasesContext {
  summary: AdminSummary | null;
  search: string;
  busyOrderId: string | null;
}

function tile(label: string, value: string, tone = ''): HTMLElement {
  return el('div', { class: `stat-tile${tone ? ` is-${tone}` : ''}` }, el('p', { class: 'stat-label' }, label), el('p', { class: 'stat-value' }, value));
}

function summaryTiles(summary: AdminSummary | null): HTMLElement {
  const grid = el('div', { class: 'stat-grid', 'aria-label': 'Resumen de la tienda' });
  if (!summary) {
    grid.append(tile('Compras', '—'), tile('Ventas', '—'), tile('Facturas emitidas', '—'), tile('Pendientes', '—'), tile('Con problema', '—'), tile('Clientes', '—'));
    return grid;
  }
  grid.append(
    tile('Compras', String(summary.orders)),
    tile('Ventas', formatMoney(summary.sales_cents)),
    tile('Facturas emitidas', String(summary.invoices.issued), 'ok'),
    tile('Facturas pendientes', String(summary.invoices.pending), summary.invoices.pending ? 'warn' : ''),
    tile('Facturas con problema', String(summary.invoices.failed), summary.invoices.failed ? 'bad' : ''),
    tile('Clientes', `${summary.customers}${summary.orders_without_account ? ` (+${summary.orders_without_account} sin cuenta)` : ''}`)
  );
  return grid;
}

function adminInvoiceCell(order: OrderSummary): HTMLElement {
  const billing = order.billing;
  if (!billing) {
    return el('span', { class: 'table-muted' }, 'Sin facturación');
  }
  if (billing.status === 'issued') {
    return el('span', { class: 'invoice-number' }, billing.invoice_number ?? 'Emitida');
  }
  if (billing.status === 'failed') {
    return el('span', { class: 'table-bad' }, `Con problema: ${billing.error ?? 'error'} (${billing.attempts} intentos)`);
  }
  return el('span', { class: 'table-warn' }, 'Pendiente');
}

export function adminPage(context: AdminContext): Node[] {
  const searchInput = el('input', {
    id: 'admin-search',
    class: 'field-input',
    type: 'search',
    name: 'q',
    maxlength: '80',
    placeholder: 'Buscar por nombre o correo del cliente',
    autocomplete: 'off'
  });
  searchInput.value = context.search;
  const searchButton = el('button', { type: 'submit', class: 'button button-secondary' });
  searchButton.append(icon('search'), el('span', {}, 'Buscar'));
  const searchForm = el(
    'form',
    { class: 'admin-search', 'data-admin-search': '', role: 'search' },
    el('label', { class: 'visually-hidden', for: 'admin-search' }, 'Buscar compras por cliente'),
    searchInput,
    searchButton
  );

  const table = el('table', { class: 'admin-table' });
  table.append(
    el(
      'thead',
      {},
      el('tr', {}, ...['Fecha', 'Cliente', 'Productos', 'Total', 'Seguimiento', 'Factura', ''].map((title) => el('th', { scope: 'col' }, title)))
    )
  );
  const body = el('tbody');
  for (const order of context.orders) {
    const actions = el('div', { class: 'table-actions' });
    if (invoiceReady(order)) {
      actions.append(invoiceLink(order.id));
    }
    if (order.billing?.status === 'failed') {
      const retry = el('button', { type: 'button', class: 'button button-secondary button-small', 'data-page-action': 'retry', 'data-order-id': order.id });
      retry.disabled = context.busyOrderId !== null;
      retry.append(icon('refresh'), el('span', {}, context.busyOrderId === order.id ? 'Reintentando…' : 'Reintentar'));
      actions.append(retry);
    }
    const customer = order.customer
      ? el('div', {}, el('p', { class: 'table-strong' }, order.customer.full_name), el('p', { class: 'table-muted' }, order.customer.email))
      : el('p', { class: 'table-muted' }, 'Sin cuenta (anterior al login)');
    body.append(
      el(
        'tr',
        {},
        el('td', { 'data-label': 'Fecha' }, el('p', { class: 'table-strong' }, formatDateTime(order.created_at)), el('p', { class: 'table-muted' }, `Pedido ${shortId(order.id)}`)),
        el('td', { 'data-label': 'Cliente' }, customer),
        el('td', { 'data-label': 'Productos' }, itemsText(order)),
        el('td', { 'data-label': 'Total', class: 'table-number' }, formatMoney(order.total_cents)),
        el('td', { 'data-label': 'Seguimiento' }, timelineNode(order.timeline, true)),
        el('td', { 'data-label': 'Factura' }, adminInvoiceCell(order)),
        el('td', { 'data-label': 'Acciones' }, actions)
      )
    );
  }
  table.append(body);

  const subtitle = context.state === 'ready' || context.orders.length > 0
    ? `${context.total} ${context.total === 1 ? 'compra' : 'compras'}${context.search ? ` para “${context.search}”` : ''}${context.refreshing ? ' · actualizando estados…' : ''}`
    : 'Cargando…';
  const emptyNode = el('p', {}, context.search || context.filter !== 'all' ? 'Ninguna compra coincide con el filtro.' : 'Aún no hay compras en la tienda.');
  return [
    pageHead('Administración', subtitle, pageButton('reload', 'Actualizar', 'refresh')),
    summaryTiles(context.summary),
    el('div', { class: 'admin-toolbar' }, searchForm, filterChips(context.filter, context.state === 'loading')),
    statusBlock(context.state, context.error, emptyNode, context.orders.length) ?? el('div', { class: 'table-wrap' }, table),
    moreButton(context.orders.length, context.total, context.loadingMore) ?? el('span')
  ];
}

// --- Factura ---------------------------------------------------------------------------

export type InvoiceProblem =
  | { kind: 'not-issued'; billingStatus: string | null; error: string | null }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string };

function invoiceToolbar(backHref: string, printable: boolean): HTMLElement {
  const back = el('a', { class: 'button button-secondary', href: backHref });
  back.append(el('span', {}, '← Volver'));
  const bar = el('div', { class: 'invoice-toolbar no-print' }, back);
  if (printable) {
    bar.append(pageButton('print', 'Imprimir / Guardar PDF', 'copy', 'button button-primary'));
  }
  return bar;
}

export function invoiceLoadingPage(backHref: string): Node[] {
  return [
    invoiceToolbar(backHref, false),
    el('p', { class: 'notice-meta page-status', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Cargando factura…')
  ];
}

export function invoiceProblemPage(problem: InvoiceProblem, backHref: string): Node[] {
  let title = 'No pudimos cargar la factura';
  let text = problem.kind === 'error' ? problem.message : '';
  if (problem.kind === 'not-found') {
    title = 'Factura no encontrada';
    text = 'No existe o pertenece a otra cuenta. Solo el titular de la compra y el administrador pueden verla.';
  } else if (problem.kind === 'not-issued') {
    title = 'La factura aún no se emitió';
    text =
      problem.billingStatus === 'failed'
        ? `La facturación tuvo un problema (${problem.error ?? 'error'}). El pedido sigue confirmado; el administrador puede reintentarla.`
        : 'El microservicio de facturación todavía la está emitiendo. Vuelve a intentarlo en unos segundos.';
  }
  const box = el('div', { class: 'panel-message page-message', role: 'status' });
  box.append(el('span', { class: 'panel-message-icon' }, icon('alert')), el('h2', { id: 'page-title', tabindex: '-1' }, title), el('p', {}, text), pageButton('reload', 'Reintentar', 'refresh'));
  return [invoiceToolbar(backHref, false), box];
}

export function invoicePage(invoice: Invoice, backHref: string): Node[] {
  const rows = el('tbody');
  for (const item of invoice.items) {
    rows.append(
      el(
        'tr',
        {},
        el('td', {}, item.name),
        el('td', { class: 'table-number' }, String(item.quantity)),
        el('td', { class: 'table-number' }, formatMoney(item.unit_price_cents)),
        el('td', { class: 'table-number' }, formatMoney(item.line_total_cents))
      )
    );
  }
  const items = el(
    'table',
    { class: 'invoice-table' },
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Descripción'), el('th', { scope: 'col', class: 'table-number' }, 'Cant.'), el('th', { scope: 'col', class: 'table-number' }, 'P. unit.'), el('th', { scope: 'col', class: 'table-number' }, 'Importe'))),
    rows
  );
  const rate = `${Math.round(invoice.totals.igv_rate * 100)}%`;
  const totals = el(
    'dl',
    { class: 'invoice-totals' },
    el('div', {}, el('dt', {}, 'Op. gravada'), el('dd', {}, formatMoney(invoice.totals.taxable_cents))),
    el('div', {}, el('dt', {}, `IGV (${rate})`), el('dd', {}, formatMoney(invoice.totals.igv_cents))),
    el('div', { class: 'invoice-grand-total' }, el('dt', {}, 'Importe total'), el('dd', {}, formatMoney(invoice.totals.total_cents)))
  );
  const verification = invoice.verified
    ? el('p', { class: 'invoice-badge is-ok' }, icon('check'), el('span', {}, 'Verificada con el microservicio de facturación'))
    : el('p', { class: 'invoice-badge is-warn' }, icon('alert'), el('span', {}, 'No se pudo verificar con el microservicio ahora: se muestran los datos guardados del pedido'));

  const customer = invoice.customer
    ? el('div', {}, el('p', { class: 'invoice-strong' }, invoice.customer.full_name), el('p', {}, invoice.customer.email))
    : el('p', { class: 'table-muted' }, 'Compra sin cuenta registrada (anterior al login)');

  const doc = el(
    'article',
    { class: 'invoice-doc', 'aria-labelledby': 'page-title' },
    el(
      'header',
      { class: 'invoice-header' },
      el(
        'div',
        {},
        el('p', { class: 'brand invoice-brand' }, el('span', { class: 'brand-name' }, 'FLASH'), el('span', { class: 'brand-slash' }, '/09')),
        el('p', {}, invoice.issuer.name)
      ),
      el(
        'div',
        { class: 'invoice-id-box' },
        el('p', { class: 'invoice-kind' }, 'Comprobante interno'),
        el('h1', { class: 'invoice-number', id: 'page-title', tabindex: '-1' }, invoice.invoice_number),
        el('p', {}, `Emitido: ${formatDateTime(invoice.issued_at)}`)
      )
    ),
    verification,
    el(
      'div',
      { class: 'invoice-parties' },
      el('section', {}, el('h2', { class: 'invoice-label' }, 'Emisor'), el('p', { class: 'invoice-strong' }, invoice.issuer.name), el('p', {}, invoice.issuer.client_id ? `Cliente de facturación: ${invoice.issuer.client_id}` : 'Microservicio de facturación DEMO')),
      el('section', {}, el('h2', { class: 'invoice-label' }, 'Cliente'), customer),
      el(
        'section',
        {},
        el('h2', { class: 'invoice-label' }, 'Pedido'),
        el('p', { class: 'invoice-strong' }, shortId(invoice.order.id)),
        el('p', { class: 'table-muted invoice-wrap' }, invoice.order.id),
        el('p', {}, formatDateTime(invoice.order.created_at)),
        el('p', {}, 'Moneda: soles (PEN)')
      )
    ),
    items,
    totals,
    el('p', { class: 'invoice-note' }, `${invoice.note} Los precios incluyen IGV.`)
  );
  return [invoiceToolbar(backHref, true), doc];
}
