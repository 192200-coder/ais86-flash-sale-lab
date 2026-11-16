import '@fontsource-variable/manrope';
import './styles.css';
import {
  ApiError,
  authErrorMessage,
  createOrder,
  fetchBilling,
  fetchCatalog,
  fetchCustomer,
  fetchOrder,
  friendlyError,
  isAbortError,
  isAuthError
} from './api';
import { initPages, isPageRoute } from './pages';
import { currentSession, expireSession, onSessionChange, signIn, signOut, signUp } from './session';
import {
  MAX_DISTINCT_PRODUCTS,
  addLine,
  cartCount,
  findLine,
  maxAddable,
  removeLine,
  sanitizeLines,
  setLineQuantity,
  toOrderItems,
  validateCart
} from './cart';
import { el, icon, pulse } from './dom';
import { formatMoney, normalizeText } from './format';
import { buildShell, productImage } from './shell';
import type { Elements } from './shell';
import {
  clearAttempt,
  newIdempotencyKey,
  readAttempt,
  readStoredCart,
  saveAttempt,
  writeStoredCart
} from './storage';
import type { AttemptRecord } from './storage';
import type { CartLine, Catalog, Order, Product } from './types';
import {
  accountPanelNodes,
  applyStockChip,
  authPanelNodes,
  cartPanelNodes,
  configureAddButton,
  customerNode,
  emptyCatalogNode,
  notificationNode,
  billingNode,
  receiptPanelNodes,
  renderProductCard,
  skeletonCards,
  syncProductCard,
  trackPanelNodes
} from './view';
import type { AuthTab, CatalogState, PollState } from './view';

type PanelMode = 'cart' | 'receipt' | 'track' | 'auth' | 'account';
type ToastTone = 'info' | 'warn';

const pollIntervalMs = 2000;
const pollWarmupMs = 1200;
const maxPollAttempts = 15;

let catalog: Catalog | null = null;
let catalogState: CatalogState = 'loading';
let catalogMessage = '';
let catalogRequestToken = 0;
let cart: CartLine[] = readStoredCart();
let activeCategory = 'all';
let searchQuery = '';
let featuredProduct: Product | null = null;
let panelMode: PanelMode = 'cart';
let activeOrder: Order | null = null;
let orderError = '';
let orderErrorCode = '';
let creating = false;
let trackingBusy = false;
let trackingError = '';
let trackingValue = '';
let trackingAbort: AbortController | null = null;
let pollState: PollState = 'idle';
let pollMessage = '';
let pollAbort: AbortController | null = null;
let pollTimer: number | null = null;
let pollToken = 0;
let pollAttempts = 0;
let billingToken = 0;
let billingTimer: number | null = null;
let lastFocused: HTMLElement | null = null;
let toastTimer: number | null = null;
// Semana 12: estado de autenticación, cuenta y administración.
let authTab: AuthTab = 'login';
let authBusy = false;
let authError = '';
let authNotice = '';
let authEmail = '';
let authFullName = '';
let afterAuthCart = false;
let customerToken = 0;

const ui: Elements = buildShell();

function start(): void {
  ui.search.addEventListener('input', onSearchInput);
  ui.searchClear.addEventListener('click', () => clearFilters(false));
  ui.chips.addEventListener('click', onCategoryClick);
  ui.grid.addEventListener('click', onGridClick);
  ui.heroAdd.addEventListener('click', () => {
    if (featuredProduct) {
      addProduct(featuredProduct.id);
    }
  });
  ui.cartButton.addEventListener('click', () => openPanel('cart'));
  ui.trackButton.addEventListener('click', () => openPanel('track'));
  ui.accountButton.addEventListener('click', () => {
    afterAuthCart = false;
    openPanel(currentSession() ? 'account' : 'auth');
  });
  onSessionChange(onSessionChanged);
  updateAccountButton();
  initPages(ui, {
    openAuth: () => {
      afterAuthCart = false;
      openPanel('auth');
    },
    openReceipt: (orderId) => void openOrderReceipt(orderId),
    toast: showToast
  });
  ui.panelClose.addEventListener('click', () => ui.panel.close());
  ui.panel.addEventListener('cancel', onPanelCancel);
  ui.panel.addEventListener('close', onPanelClose);
  ui.panel.addEventListener('click', onPanelClick);
  ui.panelBody.addEventListener('click', onPanelBodyClick);
  ui.panelBody.addEventListener('submit', onPanelSubmit);
  ui.panelBody.addEventListener('input', onPanelInput);

  updateCartCount(false);
  renderCatalogSkeletons();
  void loadCatalog();
}

async function loadCatalog(options: { silent?: boolean } = {}): Promise<void> {
  const silent = options.silent === true;
  const token = ++catalogRequestToken;

  if (!silent) {
    catalogState = 'loading';
    catalogMessage = '';
    if (!catalog) {
      renderCatalogSkeletons();
    } else {
      ui.grid.setAttribute('aria-busy', 'true');
    }
    if (ui.panel.open && panelMode === 'cart') {
      renderPanelBody(false);
    }
  }

  try {
    const data = await fetchCatalog();
    if (token !== catalogRequestToken) {
      return;
    }
    const previousSignature = cartSignature(cart);
    catalog = data;
    catalogState = 'ready';
    catalogMessage = '';
    cart = sanitizeLines(cart, data.items);
    writeStoredCart(cart);
    const changed = previousSignature !== cartSignature(cart);
    renderCatalog();
    renderCampaign();
    renderHero();
    updateCartCount(false);
    if (changed) {
      showToast('Ajustamos el carrito al stock disponible.', 'warn');
    }
    if (ui.panel.open && panelMode === 'cart') {
      renderPanelBody(false);
    }
  } catch (error) {
    if (token !== catalogRequestToken) {
      return;
    }
    if (silent && catalog) {
      showToast('No pudimos actualizar el stock.', 'warn');
      return;
    }
    catalogState = 'error';
    catalogMessage = friendlyError(error, 'catalog').message;
    renderCatalogError();
    renderCampaign();
    renderHeroUnavailable();
    if (ui.panel.open && panelMode === 'cart') {
      renderPanelBody(false);
    }
  }
}

function cartSignature(lines: readonly CartLine[]): string {
  return lines.map((line) => `${line.productId}:${line.quantity}`).join('|');
}

function renderCatalogSkeletons(): void {
  ui.search.disabled = true;
  ui.searchClear.hidden = true;
  ui.chips.replaceChildren();
  ui.catalogStatus.replaceChildren();
  ui.catalogMeta.textContent = 'Cargando catálogo…';
  ui.grid.setAttribute('aria-busy', 'true');
  ui.grid.replaceChildren(...skeletonCards());
}

function renderCatalog(): void {
  if (!catalog) {
    return;
  }
  ui.search.disabled = false;
  ui.searchClear.hidden = searchQuery.length === 0;
  ui.catalogStatus.replaceChildren();
  ui.grid.setAttribute('aria-busy', 'false');
  renderCategories();
  renderGrid();
  syncCardStates();
}

function renderCategories(): void {
  if (!catalog) {
    return;
  }
  const categories = Array.from(new Set(catalog.items.map((product) => product.category))).sort(
    (left, right) => left.localeCompare(right, 'es')
  );
  if (activeCategory !== 'all' && !categories.includes(activeCategory)) {
    activeCategory = 'all';
  }
  const buttons: HTMLButtonElement[] = [categoryButton('all', 'Todos')];
  for (const category of categories) {
    buttons.push(categoryButton(category, category));
  }
  ui.chips.replaceChildren(...buttons);
}

function categoryButton(value: string, label: string): HTMLButtonElement {
  const active = activeCategory === value;
  const button = el(
    'button',
    {
      type: 'button',
      class: 'chip chip-filter',
      'data-category': value,
      'aria-pressed': active ? 'true' : 'false',
      'aria-controls': 'product-grid'
    },
    label
  );
  button.classList.toggle('is-active', active);
  return button;
}

function renderGrid(): void {
  if (!catalog || catalogState !== 'ready') {
    return;
  }
  const term = normalizeText(searchQuery);
  const filtered = catalog.items.filter((product) => {
    const inCategory = activeCategory === 'all' || product.category === activeCategory;
    if (!inCategory) {
      return false;
    }
    if (term.length === 0) {
      return true;
    }
    return normalizeText(`${product.name} ${product.description} ${product.category}`).includes(term);
  });

  ui.grid.replaceChildren();
  if (filtered.length === 0) {
    const noFilters = term.length === 0 && activeCategory === 'all';
    ui.grid.append(emptyCatalogNode(noFilters ? 'catalog' : 'search', searchQuery, activeCategory));
    ui.catalogMeta.textContent =
      catalog.items.length === 0 ? 'Sin productos' : 'Sin resultados';
    return;
  }

  for (const product of filtered) {
    const quantity = findLine(cart, product.id)?.quantity ?? 0;
    ui.grid.append(renderProductCard(product, quantity, creating));
  }
  const total = catalog.items.length;
  ui.catalogMeta.textContent =
    filtered.length === total
      ? `${total} ${total === 1 ? 'producto' : 'productos'}`
      : `${filtered.length} de ${total} productos`;
}

function syncCardStates(): void {
  if (!catalog) {
    return;
  }
  for (const card of Array.from(ui.grid.querySelectorAll<HTMLElement>('.card[data-product]'))) {
    const productId = card.dataset.product;
    if (!productId) {
      continue;
    }
    const product = findProduct(productId);
    if (!product) {
      continue;
    }
    const quantity = findLine(cart, productId)?.quantity ?? 0;
    syncProductCard(card, product, quantity, creating);
  }
  if (featuredProduct) {
    applyStockChip(ui.heroStock, featuredProduct);
    configureAddButton(
      ui.heroAdd,
      featuredProduct,
      findLine(cart, featuredProduct.id)?.quantity ?? 0,
      creating
    );
  }
}

function renderHero(): void {
  if (!catalog || catalog.items.length === 0) {
    renderHeroUnavailable();
    return;
  }
  const product =
    catalog.items.find((item) => item.id === 'nova-headphones') ?? catalog.items[0] ?? null;
  if (!product) {
    renderHeroUnavailable();
    return;
  }
  featuredProduct = product;
  ui.heroImage.classList.remove('is-skeleton', 'is-unavailable');
  ui.heroImage.replaceChildren();
  const image = productImage(product.image, 'hero-product-image', false);
  image.setAttribute('fetchpriority', 'high');
  ui.heroImage.append(image);
  ui.heroName.textContent = product.name;
  ui.heroPrice.textContent = formatMoney(product.price_cents);
  if (product.original_price_cents > product.price_cents) {
    ui.heroOldPrice.textContent = formatMoney(product.original_price_cents);
    ui.heroOldPrice.hidden = false;
  } else {
    ui.heroOldPrice.textContent = '';
    ui.heroOldPrice.hidden = true;
  }
  ui.heroStock.hidden = false;
  applyStockChip(ui.heroStock, product);
  configureAddButton(
    ui.heroAdd,
    product,
    findLine(cart, product.id)?.quantity ?? 0,
    creating
  );
}

function renderHeroUnavailable(): void {
  featuredProduct = null;
  ui.heroImage.classList.remove('is-skeleton');
  ui.heroImage.classList.add('is-unavailable');
  ui.heroImage.replaceChildren(el('p', { class: 'hero-unavailable' }, 'Catálogo no disponible'));
  ui.heroName.textContent = 'Catálogo no disponible';
  ui.heroPrice.textContent = '—';
  ui.heroOldPrice.textContent = '';
  ui.heroOldPrice.hidden = true;
  ui.heroStock.hidden = true;
  ui.heroStock.textContent = '';
  ui.heroStock.classList.remove('is-available', 'is-low', 'is-out');
  ui.heroAdd.disabled = true;
  const label = ui.heroAdd.querySelector<HTMLElement>('[data-button-label]');
  if (label) {
    label.textContent = 'No disponible';
  }
  ui.heroAdd.setAttribute('aria-label', 'Añadir no disponible: catálogo sin cargar');
}

function renderCampaign(): void {
  ui.campaign.classList.remove('is-ended', 'is-muted');
  ui.campaign.textContent = 'Campaña de práctica · stock limitado';
}

function renderCatalogError(): void {
  ui.search.disabled = true;
  ui.searchClear.hidden = true;
  ui.chips.replaceChildren();
  ui.grid.replaceChildren();
  ui.grid.setAttribute('aria-busy', 'false');
  ui.catalogMeta.textContent = 'Catálogo no disponible';
  const retry = el('button', { type: 'button', class: 'button button-secondary' });
  retry.append(icon('refresh'), el('span', {}, 'Reintentar'));
  retry.addEventListener('click', () => {
    void loadCatalog();
  });
  const alert = el(
    'div',
    { class: 'alert alert-error catalog-alert', role: 'alert' },
    icon('alert'),
    el(
      'div',
      { class: 'alert-body' },
      el('h3', {}, 'No pudimos cargar el catálogo'),
      el('p', {}, catalogMessage),
      retry
    )
  );
  ui.catalogStatus.replaceChildren(alert);
}

function findProduct(productId: string): Product | null {
  return catalog?.items.find((product) => product.id === productId) ?? null;
}

function findCard(productId: string): HTMLElement | null {
  return (
    Array.from(ui.grid.querySelectorAll<HTMLElement>('.card')).find(
      (card) => card.dataset.product === productId
    ) ?? null
  );
}

function onSearchInput(): void {
  searchQuery = ui.search.value;
  ui.searchClear.hidden = searchQuery.length === 0;
  if (catalogState === 'ready') {
    renderGrid();
  }
}

function clearFilters(resetCategory: boolean): void {
  searchQuery = '';
  ui.search.value = '';
  ui.searchClear.hidden = true;
  if (resetCategory) {
    activeCategory = 'all';
  }
  syncCategoryChips();
  renderGrid();
  ui.search.focus();
}

function onCategoryClick(event: MouseEvent): void {
  if (!(event.target instanceof Element)) {
    return;
  }
  const button = event.target.closest<HTMLButtonElement>('button[data-category]');
  if (!button || !ui.chips.contains(button)) {
    return;
  }
  const value = button.dataset.category;
  if (!value || value === activeCategory) {
    return;
  }
  activeCategory = value;
  syncCategoryChips();
  renderGrid();
}

function syncCategoryChips(): void {
  for (const button of Array.from(
    ui.chips.querySelectorAll<HTMLButtonElement>('button[data-category]')
  )) {
    const active = button.dataset.category === activeCategory;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function onGridClick(event: MouseEvent): void {
  if (!(event.target instanceof Element)) {
    return;
  }
  const actionButton = event.target.closest<HTMLElement>('[data-action]');
  if (actionButton && ui.grid.contains(actionButton)) {
    const action = actionButton.dataset.action;
    if (action === 'clear-filters') {
      clearFilters(true);
      return;
    }
    if (action === 'reload-catalog') {
      void loadCatalog();
      return;
    }
  }
  const addButton = event.target.closest<HTMLButtonElement>('button[data-add]');
  if (addButton && ui.grid.contains(addButton) && addButton.dataset.add) {
    addProduct(addButton.dataset.add);
  }
}

function addProduct(productId: string): void {
  if (catalogState !== 'ready' || !catalog) {
    showToast('El catálogo aún no está disponible.', 'warn');
    return;
  }
  if (creating) {
    showToast('Espera a que termine la confirmación del pedido.', 'warn');
    return;
  }
  const product = findProduct(productId);
  if (!product) {
    showToast('Ese producto ya no está disponible.', 'warn');
    return;
  }
  const result = addLine(cart, product);
  if (result.result === 'out') {
    showToast(`${product.name} está agotado.`, 'warn');
    return;
  }
  if (result.result === 'max') {
    showToast(`Ya tienes el máximo disponible de ${product.name}.`, 'warn');
    const card = findCard(product.id);
    const inCartChip = card?.querySelector<HTMLElement>('[data-role="incart"]');
    if (inCartChip) {
      pulse(inCartChip);
    }
    return;
  }
  if (result.result === 'limit') {
    showToast(`Máximo ${MAX_DISTINCT_PRODUCTS} productos distintos por pedido.`, 'warn');
    return;
  }

  cart = result.lines;
  clearOrderError();
  writeStoredCart(cart);
  updateCartCount(true);
  syncCardStates();
  const quantity = findLine(cart, product.id)?.quantity ?? 1;
  const card = findCard(product.id);
  if (card) {
    const stockChip = card.querySelector<HTMLElement>('[data-role="stock"]');
    const inCartChip = card.querySelector<HTMLElement>('[data-role="incart"]');
    if (stockChip) {
      pulse(stockChip);
    }
    if (inCartChip) {
      pulse(inCartChip);
    }
  }
  if (featuredProduct?.id === product.id) {
    pulse(ui.heroStock);
  }
  showToast(`Añadido: ${product.name} · ${quantity} en el carrito.`);
}

function clearOrderError(): void {
  orderError = '';
  orderErrorCode = '';
}

function updateCartCount(animate: boolean): void {
  const count = cartCount(cart);
  ui.cartCount.textContent = String(count);
  ui.cartButton.setAttribute(
    'aria-label',
    `Abrir carrito, ${count} ${count === 1 ? 'unidad' : 'unidades'}`
  );
  ui.cartButton.classList.toggle('has-items', count > 0);
  if (animate) {
    pulse(ui.cartCount, 'is-bumping');
  }
}

function showToast(message: string, tone: ToastTone = 'info'): void {
  ui.toast.dataset.tone = tone;
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    ui.toast.hidden = true;
    toastTimer = null;
  }, 3400);
}

function hideToast(): void {
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
    toastTimer = null;
  }
  ui.toast.hidden = true;
}

function openPanel(mode: PanelMode): void {
  if (ui.panel.open) {
    if (panelMode !== mode) {
      setPanelMode(mode);
    }
    return;
  }
  lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (mode === 'track') {
    abortTracking();
    trackingError = '';
    trackingBusy = false;
    trackingValue = '';
  }
  panelMode = resolveMode(mode);
  renderPanel(true);
  ui.panel.showModal();
  document.documentElement.classList.add('has-dialog');
  focusPanelStart(panelMode);
}

/** Semana 12: sin sesión, "Mi cuenta" redirige a iniciar sesión. */
function resolveMode(mode: PanelMode): PanelMode {
  if (mode === 'account' && !currentSession()) {
    mode = 'auth';
  }
  if (mode === 'auth') {
    authBusy = false;
    authError = '';
  } else {
    authNotice = '';
  }
  return mode;
}

function setPanelMode(mode: PanelMode): void {
  if (panelMode === 'receipt' && mode !== 'receipt') {
    stopPolling();
  }
  if (panelMode === 'track' && mode !== 'track') {
    abortTracking();
  }
  if (mode === 'track') {
    trackingError = '';
    trackingBusy = false;
    trackingValue = '';
  }
  panelMode = resolveMode(mode);
  renderPanel(true);
  focusPanelStart(panelMode);
}

function focusPanelStart(mode: PanelMode): void {
  window.requestAnimationFrame(() => {
    if (mode === 'auth') {
      const input = ui.panelBody.querySelector<HTMLInputElement>('#auth-name, #auth-email');
      if (input) {
        input.focus();
        return;
      }
    }
    if (mode === 'track') {
      const input = ui.panelBody.querySelector<HTMLInputElement>('#order-lookup');
      if (input) {
        input.focus();
        input.select();
        return;
      }
    }
    ui.panelClose.focus();
  });
}

function onPanelCancel(event: Event): void {
  if (creating) {
    event.preventDefault();
  }
}

function onPanelClose(): void {
  stopPolling();
  abortTracking();
  document.documentElement.classList.remove('has-dialog');
  const target = lastFocused;
  lastFocused = null;
  if (target?.isConnected) {
    target.focus();
  }
}

function onPanelClick(event: MouseEvent): void {
  if (event.target === ui.panel && !creating) {
    ui.panel.close();
  }
}

function onPanelInput(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.id === 'order-lookup') {
    trackingValue = target.value;
    if (trackingError) {
      clearTrackError();
    }
  }
  if (target instanceof HTMLInputElement && target.id === 'auth-email') {
    authEmail = target.value;
  }
  if (target instanceof HTMLInputElement && target.id === 'auth-name') {
    authFullName = target.value;
  }
}

function onPanelSubmit(event: SubmitEvent): void {
  if (!(event.target instanceof HTMLFormElement)) {
    return;
  }
  if (event.target.matches('[data-auth-form]')) {
    event.preventDefault();
    void submitAuth(event.target);
    return;
  }
  if (!event.target.matches('[data-lookup-form]')) {
    return;
  }
  event.preventDefault();
  void lookupOrder();
}

function onPanelBodyClick(event: MouseEvent): void {
  if (!(event.target instanceof Element)) {
    return;
  }
  const button = event.target.closest<HTMLElement>('[data-action]');
  if (!button) {
    return;
  }
  const action = button.dataset.action;
  const productId = button.dataset.productId;
  const focusKey = button.dataset.focusKey;
  switch (action) {
    case 'qty-minus':
      if (productId) {
        updateCartQuantity(productId, -1, focusKey);
      }
      break;
    case 'qty-plus':
      if (productId) {
        updateCartQuantity(productId, 1, focusKey);
      }
      break;
    case 'remove':
      if (productId) {
        removeCartProduct(productId);
      }
      break;
    case 'confirm':
      void confirmOrder();
      break;
    case 'refresh-catalog':
      void loadCatalog({ silent: catalog !== null });
      break;
    case 'reload-catalog':
      void loadCatalog();
      break;
    case 'copy-id':
      if (activeOrder && button instanceof HTMLButtonElement) {
        void copyOrderId(activeOrder.id, button);
      }
      break;
    case 'poll-again':
      startPolling();
      break;
    case 'open-track':
      setPanelMode('track');
      break;
    case 'open-auth':
      afterAuthCart = panelMode === 'cart';
      setPanelMode('auth');
      break;
    case 'auth-tab':
      if (!authBusy && (button.dataset.tab === 'login' || button.dataset.tab === 'signup')) {
        authTab = button.dataset.tab;
        authError = '';
        authNotice = '';
        renderPanelBody(false);
        focusPanelStart('auth');
      }
      break;
    case 'logout':
      void logout();
      break;
    case 'goto-page':
      // Enlace a una página (#mis-compras, #admin, #factura/...): se cierra el diálogo y
      // el navegador sigue el enlace (no se cancela el clic).
      ui.panel.close();
      break;
    case 'browse':
      ui.panel.close();
      window.setTimeout(() => {
        focusCatalog();
      }, 0);
      break;
  }
}

function focusCatalog(): void {
  const heading = document.getElementById('catalog-title');
  heading?.focus();
  heading?.scrollIntoView({ block: 'start' });
}

function renderPanel(resetScroll: boolean): void {
  const titles: Record<PanelMode, string> = {
    cart: 'Carrito',
    receipt: 'Pedido confirmado',
    track: 'Seguimiento',
    auth: authTab === 'login' ? 'Iniciar sesión' : 'Crear cuenta',
    account: 'Mi cuenta'
  };
  const closeLabels: Record<PanelMode, string> = {
    cart: 'Cerrar carrito',
    receipt: 'Cerrar recibo',
    track: 'Cerrar seguimiento',
    auth: 'Cerrar inicio de sesión',
    account: 'Cerrar mi cuenta'
  };
  ui.panelTitle.textContent = titles[panelMode];
  ui.panelClose.setAttribute('aria-label', closeLabels[panelMode]);
  ui.panelClose.disabled = creating;
  if (creating) {
    ui.panel.setAttribute('aria-busy', 'true');
  } else {
    ui.panel.removeAttribute('aria-busy');
  }
  renderPanelBody(resetScroll);
}

function renderPanelBody(resetScroll: boolean): void {
  const scrollTop = resetScroll ? 0 : ui.panelBody.scrollTop;
  let nodes: Node[];
  if (panelMode === 'cart') {
    nodes = cartPanelNodes({
      catalog,
      catalogState,
      catalogMessage,
      cart,
      orderError,
      orderErrorCode,
      creating,
      session: currentSession()
    });
  } else if (panelMode === 'receipt') {
    nodes = receiptPanelNodes(activeOrder, pollState, pollMessage);
  } else if (panelMode === 'auth') {
    ui.panelTitle.textContent = authTab === 'login' ? 'Iniciar sesión' : 'Crear cuenta';
    nodes = authPanelNodes({
      tab: authTab,
      busy: authBusy,
      error: authError,
      notice: authNotice,
      email: authEmail,
      fullName: authFullName,
      afterAuthCart
    });
  } else if (panelMode === 'account') {
    const session = currentSession();
    nodes = session ? accountPanelNodes({ session }) : [];
  } else {
    nodes = trackPanelNodes(trackingValue, trackingError, trackingBusy);
  }
  ui.panelBody.replaceChildren(...nodes);
  ui.panelBody.scrollTop = scrollTop;
}

function updateCartQuantity(productId: string, delta: number, focusKey: string | undefined): void {
  if (!catalog || creating) {
    return;
  }
  const product = findProduct(productId);
  const line = findLine(cart, productId);
  if (!product || !line) {
    return;
  }
  const next = line.quantity + delta;
  const limit = maxAddable(product);
  if (next < 1 || next > limit) {
    return;
  }
  cart = setLineQuantity(cart, product, next);
  clearOrderError();
  writeStoredCart(cart);
  updateCartCount(true);
  syncCardStates();
  renderPanelBody(false);
  focusByKey(focusKey);
}

function removeCartProduct(productId: string): void {
  if (!catalog || creating) {
    return;
  }
  cart = removeLine(cart, productId);
  clearOrderError();
  writeStoredCart(cart);
  updateCartCount(true);
  syncCardStates();
  renderPanelBody(false);
  const next =
    ui.panelBody.querySelector<HTMLElement>('[data-action="remove"]') ??
    ui.panelBody.querySelector<HTMLElement>('[data-action="browse"]');
  (next ?? ui.panelClose).focus();
}

function focusByKey(focusKey: string | undefined): void {
  if (focusKey) {
    const target = Array.from(
      ui.panelBody.querySelectorAll<HTMLElement>('[data-focus-key]')
    ).find((node) => node.dataset.focusKey === focusKey);
    if (target) {
      if (!(target instanceof HTMLButtonElement && target.disabled)) {
        target.focus();
        return;
      }
      const value = target
        .closest('.qty-control')
        ?.querySelector<HTMLElement>('.qty-value');
      if (value) {
        value.focus();
        return;
      }
    }
  }
  ui.panelClose.focus();
}

function ensureAttempt(items: Array<{ product_id: string; quantity: number }>): AttemptRecord {
  const signature = JSON.stringify(items);
  const stored = readAttempt();
  if (stored && stored.signature === signature) {
    return stored;
  }
  const record: AttemptRecord = { key: newIdempotencyKey(), signature };
  saveAttempt(record);
  return record;
}

async function confirmOrder(): Promise<void> {
  if (creating || !catalog) {
    return;
  }
  const validation = validateCart(cart, catalog.items);
  if (!validation.ok) {
    renderPanelBody(false);
    const warning = ui.panelBody.querySelector<HTMLElement>('.alert-warning, [data-order-error]');
    if (warning) {
      warning.setAttribute('tabindex', '-1');
      warning.focus();
    }
    return;
  }

  const items = toOrderItems(cart, catalog.items);
  if (items.length === 0) {
    return;
  }
  // Semana 12: sin sesión no se puede comprar (la API responde 401 AUTH_REQUIRED).
  if (!currentSession()) {
    afterAuthCart = true;
    setPanelMode('auth');
    return;
  }
  const attempt = ensureAttempt(items);
  hideToast();
  creating = true;
  orderError = '';
  orderErrorCode = '';
  renderPanel(false);
  syncCardStates();
  window.requestAnimationFrame(() => {
    if (creating) {
      ui.panelTitle.focus();
    }
  });

  try {
    const order = await createOrder(items, attempt.key);
    clearAttempt();
    creating = false;
    cart = [];
    writeStoredCart(cart);
    updateCartCount(true);
    syncCardStates();
    beginReceipt(order);
    void loadCatalog({ silent: true });
  } catch (error) {
    creating = false;
    const info = friendlyError(error, 'create');
    orderError = info.message;
    orderErrorCode = info.code;
    if (isAuthError(error)) {
      // Sesión inválida o expirada: se descarta y se pide iniciar sesión de nuevo.
      expireSession();
      clearAttempt();
      afterAuthCart = true;
      authNotice = '';
      authError = orderError;
      clearOrderError();
      panelMode = 'auth';
      authBusy = false;
      renderPanel(false);
      syncCardStates();
      focusPanelStart('auth');
      return;
    }
    if (error instanceof ApiError) {
      if (error.code === 'IDEMPOTENCY_CONFLICT' || error.code === 'VALIDATION_ERROR') {
        clearAttempt();
      }
      if (error.code === 'OUT_OF_STOCK') {
        void loadCatalog({ silent: catalog !== null });
      }
    }
    renderPanel(false);
    syncCardStates();
    const alert = ui.panelBody.querySelector<HTMLElement>('[data-order-error]');
    alert?.focus();
  }
}

function beginReceipt(order: Order): void {
  abortTracking();
  stopPolling();
  activeOrder = order;
  panelMode = 'receipt';
  pollState = order.notification_status === 'pending' ? 'polling' : 'idle';
  pollMessage = '';
  renderPanel(true);
  focusPanelStart('receipt');
  if (order.notification_status === 'pending') {
    startPolling();
  }
  startBillingPoll(order.id);
  void loadReceiptCustomer(order.id);
}

/** Semana 12: comprador del pedido (solo lo ven su titular y el administrador). */
async function loadReceiptCustomer(orderId: string): Promise<void> {
  const token = ++customerToken;
  const render = (node: HTMLElement): void => {
    if (token !== customerToken || panelMode !== 'receipt' || activeOrder?.id !== orderId) {
      return;
    }
    ui.panelBody.querySelector('[data-receipt-customer]')?.replaceWith(node);
  };
  if (!currentSession()) {
    render(customerNode(null));
    return;
  }
  try {
    render(customerNode(await fetchCustomer(orderId)));
  } catch {
    render(customerNode(null));
  }
}

/** Semana 12: abre el recibo de un pedido (desde "Mis compras"), con el diálogo si estaba cerrado. */
async function openOrderReceipt(orderId: string): Promise<void> {
  try {
    const order = await fetchOrder(orderId);
    if (!ui.panel.open) {
      lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      panelMode = 'receipt';
      activeOrder = order;
      renderPanel(true);
      ui.panel.showModal();
      document.documentElement.classList.add('has-dialog');
    }
    beginReceipt(order);
  } catch (error) {
    showToast(friendlyError(error, 'order').message, 'warn');
  }
}

async function submitAuth(form: HTMLFormElement): Promise<void> {
  if (authBusy) {
    return;
  }
  const data = new FormData(form);
  const email = String(data.get('email') ?? '').trim();
  const password = String(data.get('password') ?? '');
  const fullName = String(data.get('full_name') ?? '').trim();
  authEmail = email;
  authFullName = fullName;
  if (!email || !password || (authTab === 'signup' && fullName.length < 2)) {
    setAuthError('Completa todos los campos.');
    return;
  }
  if (authTab === 'signup' && password.length < 8) {
    setAuthError('La contraseña debe tener al menos 8 caracteres.');
    return;
  }
  authBusy = true;
  authError = '';
  renderPanelBody(false);
  try {
    const session = authTab === 'login' ? await signIn(email, password) : await signUp(fullName, email, password);
    authBusy = false;
    if (!session) {
      authTab = 'login';
      authNotice = 'Cuenta creada. Revisa tu correo para confirmarla y luego inicia sesión.';
      renderPanel(false);
      focusPanelStart('auth');
      return;
    }
    authFullName = '';
    showToast(`Hola, ${session.user.full_name}.`);
    if (afterAuthCart) {
      setPanelMode('cart');
    } else if (isPageRoute()) {
      // Se inició sesión desde una página (#mis-compras, #factura/...): la página se recarga sola.
      ui.panel.close();
    } else {
      setPanelMode('account');
    }
    afterAuthCart = false;
  } catch (error) {
    authBusy = false;
    renderPanelBody(false);
    setAuthError(authErrorMessage(error, authTab));
  }
}

function setAuthError(message: string): void {
  authError = message;
  const box = ui.panelBody.querySelector<HTMLElement>('[data-auth-error]');
  if (box) {
    box.textContent = message;
    box.hidden = false;
    box.focus();
  }
}

async function logout(): Promise<void> {
  await signOut();
  showToast('Sesión cerrada.');
}

function onSessionChanged(): void {
  updateAccountButton();
  if (!ui.panel.open) {
    return;
  }
  if (!currentSession() && panelMode === 'account') {
    setPanelMode('auth');
    return;
  }
  if (panelMode === 'cart') {
    renderPanelBody(false);
  }
}

function updateAccountButton(): void {
  const session = currentSession();
  ui.accountLabel.textContent = session ? session.user.full_name.split(/\s+/)[0] ?? 'Mi cuenta' : 'Iniciar sesión';
  ui.accountButton.classList.toggle('is-signed-in', session !== null);
  ui.accountButton.classList.toggle('is-admin', session?.user.role === 'admin');
  ui.accountButton.setAttribute(
    'aria-label',
    session
      ? `Mi cuenta: ${session.user.full_name}${session.user.role === 'admin' ? ', administrador' : ''}`
      : 'Iniciar sesión o crear cuenta'
  );
}

/** Semana 11: consulta el comprobante aparte; su estado no afecta al pedido ni a la notificación. */
function startBillingPoll(orderId: string): void {
  const token = ++billingToken;
  if (billingTimer !== null) {
    window.clearTimeout(billingTimer);
  }
  let attempts = 0;
  const render = (node: HTMLElement): void => {
    if (token !== billingToken || panelMode !== 'receipt' || activeOrder?.id !== orderId) {
      return;
    }
    ui.panelBody.querySelector('[data-receipt-billing]')?.replaceWith(node);
  };
  const tick = async (): Promise<void> => {
    if (token !== billingToken) {
      return;
    }
    attempts += 1;
    try {
      const billing = await fetchBilling(orderId);
      render(billingNode(billing, false, currentSession() ? orderId : null));
      if (billing.status === 'pending' && attempts < maxPollAttempts) {
        billingTimer = window.setTimeout(() => void tick(), pollIntervalMs);
      }
    } catch {
      render(billingNode(null, true));
    }
  };
  billingTimer = window.setTimeout(() => void tick(), 500);
}

function startPolling(): void {
  if (!activeOrder) {
    return;
  }
  const order = activeOrder;
  stopPolling();
  if (order.notification_status !== 'pending') {
    updateReceiptNotification();
    return;
  }

  pollState = 'polling';
  pollMessage = '';
  pollAttempts = 0;
  const token = ++pollToken;
  const controller = new AbortController();
  pollAbort = controller;
  updateReceiptNotification();

  const tick = async (): Promise<void> => {
    if (token !== pollToken) {
      return;
    }
    pollAttempts += 1;
    try {
      const next = await fetchOrder(order.id, controller.signal);
      if (token !== pollToken) {
        return;
      }
      activeOrder = next;
      if (next.notification_status !== 'pending') {
        pollState = 'idle';
        pollMessage = '';
        clearPolling();
        updateReceiptNotification();
        return;
      }
      if (pollAttempts >= maxPollAttempts) {
        pollState = 'timeout';
        pollMessage = 'La notificación sigue pendiente. Puedes consultar el pedido de nuevo con su ID.';
        clearPolling();
        updateReceiptNotification();
        return;
      }
      updateReceiptNotification();
      pollTimer = window.setTimeout(() => {
        void tick();
      }, pollIntervalMs);
    } catch (error) {
      if (isAbortError(error) || token !== pollToken) {
        return;
      }
      pollState = 'error';
      pollMessage = friendlyError(error, 'order').message;
      clearPolling();
      updateReceiptNotification();
    }
  };

  pollTimer = window.setTimeout(() => {
    void tick();
  }, pollWarmupMs);
}

function clearPolling(): void {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (pollAbort) {
    pollAbort.abort();
    pollAbort = null;
  }
}

function stopPolling(): void {
  pollToken += 1;
  clearPolling();
  pollState = 'idle';
  pollMessage = '';
}

function updateReceiptNotification(): void {
  if (!ui.panel.open || panelMode !== 'receipt' || !activeOrder) {
    return;
  }
  const current = ui.panelBody.querySelector('[data-receipt-status]');
  if (current) {
    current.replaceWith(notificationNode(activeOrder, pollState, pollMessage));
  }
}

async function lookupOrder(): Promise<void> {
  if (trackingBusy) {
    return;
  }
  const input = ui.panelBody.querySelector<HTMLInputElement>('#order-lookup');
  const id = (input?.value ?? trackingValue).trim();
  trackingValue = id;
  if (id.length === 0) {
    showTrackError('Introduce el ID del pedido.');
    input?.focus();
    return;
  }
  if (id.length > 120) {
    showTrackError('El ID del pedido no es válido.');
    input?.focus();
    return;
  }

  trackingBusy = true;
  trackingError = '';
  setTrackBusyUi(true);
  const controller = new AbortController();
  trackingAbort = controller;

  try {
    const order = await fetchOrder(id, controller.signal);
    if (controller.signal.aborted) {
      return;
    }
    trackingAbort = null;
    trackingBusy = false;
    beginReceipt(order);
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) {
      return;
    }
    trackingAbort = null;
    trackingBusy = false;
    setTrackBusyUi(false);
    showTrackError(friendlyError(error, 'order').message);
  }
}

function setTrackBusyUi(busy: boolean): void {
  const form = ui.panelBody.querySelector<HTMLFormElement>('[data-lookup-form]');
  const button = form?.querySelector<HTMLButtonElement>('[data-track-submit]');
  const label = form?.querySelector<HTMLElement>('[data-track-submit-label]');
  if (button) {
    button.disabled = busy;
  }
  if (label) {
    label.textContent = busy ? 'Consultando…' : 'Consultar pedido';
  }
  if (form) {
    if (busy) {
      form.setAttribute('aria-busy', 'true');
    } else {
      form.removeAttribute('aria-busy');
    }
  }
}

function showTrackError(message: string): void {
  trackingError = message;
  const box = ui.panelBody.querySelector<HTMLElement>('[data-track-error]');
  if (box) {
    box.textContent = message;
    box.hidden = false;
    box.focus();
  }
}

function clearTrackError(): void {
  trackingError = '';
  const box = ui.panelBody.querySelector<HTMLElement>('[data-track-error]');
  if (box) {
    box.textContent = '';
    box.hidden = true;
  }
}

function abortTracking(): void {
  if (trackingAbort) {
    trackingAbort.abort();
    trackingAbort = null;
  }
  trackingBusy = false;
}

async function copyOrderId(orderId: string, button: HTMLButtonElement): Promise<void> {
  const input = ui.panelBody.querySelector<HTMLInputElement>('[data-order-id]');
  const hint = ui.panelBody.querySelector<HTMLElement>('[data-copy-hint]');
  const label = button.querySelector<HTMLElement>('[data-copy-label]');
  try {
    await navigator.clipboard.writeText(orderId);
    if (label) {
      label.textContent = 'Copiado';
    }
    if (hint) {
      hint.hidden = true;
      hint.textContent = '';
    }
    window.setTimeout(() => {
      if (label?.isConnected) {
        label.textContent = 'Copiar ID';
      }
    }, 2200);
  } catch {
    if (hint) {
      hint.hidden = false;
      hint.textContent = 'Selecciona el ID y cópialo manualmente.';
    }
    if (label) {
      label.textContent = 'Copia manual';
    }
    input?.focus();
    input?.select();
    window.setTimeout(() => {
      if (label?.isConnected) {
        label.textContent = 'Copiar ID';
      }
    }, 2200);
  }
}

start();
