"""Comprador del pedido, compras, seguimiento, factura y administración (Semana 12).

Los datos de la persona autenticada se guardan en una tabla aparte (`order_customers`),
en la misma transacción que el pedido. El JSON público del pedido, el evento CloudEvents y
la petición al microservicio de facturación NO cambian: el comprador solo se expone en rutas
nuevas que exigen sesión.

Factura: S09 la compone a partir de la factura OFICIAL del microservicio (consultada en vivo
con GET /invoices/{id}: número, fecha de emisión, líneas y total) más el comprador que guarda
S09. El microservicio no cambia.

Permisos:
  - anónimo  : ver catálogo y consultar un pedido por su ID (contrato S09); NO puede comprar.
  - cliente  : comprar; ver SUS compras, su seguimiento y SUS facturas.
  - admin    : todo lo anterior para cualquier compra + resumen de ventas y reintento de
               facturaciones fallidas.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import DateTime, ForeignKey, String, Uuid, and_, distinct, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from .auth import CurrentUser, require_admin, require_user
from .billing import FAILED, ISSUED, PENDING, OrderBilling, billing_view, fetch_invoice
from .db import Base, utcnow
from .events import iso8601
from .models import Notification, Order
from .security import ApiError, DatasetContext, dataset_context, get_session, get_settings_from_request

IGV_RATE = Decimal("0.18")
STORE_NAME = "FLASH · Tienda de demostración"
INVOICE_NOTE = "Comprobante interno de demostración: no es un comprobante electrónico válido ante SUNAT."
BillingFilter = Literal["pending", "issued", "failed"]


class OrderCustomer(Base):
    """Quién hizo el pedido. Datos tomados del JWT verificado, nunca del cuerpo de la petición."""

    __tablename__ = "order_customers"

    order_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("orders.id", ondelete="CASCADE"), primary_key=True
    )
    dataset_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(254), nullable=False)
    full_name: Mapped[str] = mapped_column(String(80), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


def customer_view(row: OrderCustomer) -> dict[str, Any]:
    return {"user_id": str(row.user_id), "email": row.email, "full_name": row.full_name}


def igv_split(total_cents: int) -> tuple[int, int]:
    """Precios con IGV incluido: total = gravada + IGV. Devuelve (gravada, igv) en céntimos."""
    taxable = int((Decimal(total_cents) / (1 + IGV_RATE)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return taxable, total_cents - taxable


def _order_id(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        raise ApiError(404, "NOT_FOUND", "Order not found") from None


def _iso(value: datetime | None) -> str | None:
    return iso8601(value) if value else None


def timeline(order: Order, notification: Notification | None, billing: OrderBilling | None) -> list[dict[str, Any]]:
    """Seguimiento: confirmado -> notificación -> factura, con la fecha de cada paso."""
    notified = order.notification_status == "sent"
    notification_state = "done" if notified else "failed" if order.notification_status == "failed" else "pending"
    if billing is None:
        invoice_state, invoice_at, detail = "none", None, None
    elif billing.status == ISSUED:
        invoice_state, invoice_at, detail = "done", billing.updated_at, billing.invoice_number
    elif billing.status == FAILED:
        invoice_state, invoice_at, detail = "failed", billing.updated_at, billing.last_error
    else:
        invoice_state, invoice_at, detail = "pending", None, None
    return [
        {"step": "confirmed", "state": "done", "at": _iso(order.created_at), "detail": None},
        {
            "step": "notification",
            "state": notification_state,
            "at": _iso(notification.created_at) if notified and notification else None,
            "detail": None,
        },
        {"step": "invoice", "state": invoice_state, "at": _iso(invoice_at), "detail": detail},
    ]


def _billing_summary(row: OrderBilling | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "status": row.status,
        "invoice_number": row.invoice_number,
        "error": row.last_error,
        "attempts": row.attempts,
    }


def _order_summary(
    order: Order,
    customer: OrderCustomer | None,
    billing: OrderBilling | None,
    notification: Notification | None,
) -> dict[str, Any]:
    items = order.snapshot.get("items", []) if isinstance(order.snapshot, dict) else []
    return {
        "id": str(order.id),
        "created_at": iso8601(order.created_at),
        "total_cents": order.total_cents,
        "notification_status": order.notification_status,
        "items": [{"name": item.get("name"), "quantity": item.get("quantity")} for item in items],
        "customer": customer_view(customer) if customer else None,
        "billing": _billing_summary(billing),
        "timeline": timeline(order, notification, billing),
    }


def _purchases_query(dataset_id: str, *columns):
    return (
        select(*(columns or (Order, OrderCustomer, OrderBilling, Notification)))
        .select_from(Order)
        .outerjoin(OrderCustomer, OrderCustomer.order_id == Order.id)
        .outerjoin(OrderBilling, OrderBilling.order_id == Order.id)
        .outerjoin(
            Notification,
            and_(Notification.order_id == Order.id, Notification.dataset_id == Order.dataset_id),
        )
        .where(Order.dataset_id == dataset_id)
    )


def _apply_filters(query, billing: BillingFilter | None, search: str | None):
    if billing is not None:
        query = query.where(OrderBilling.status == billing)
    if search:
        escaped = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        query = query.where(
            or_(OrderCustomer.email.ilike(pattern, escape="\\"), OrderCustomer.full_name.ilike(pattern, escape="\\"))
        )
    return query


async def _page(session: AsyncSession, build, limit: int, offset: int) -> dict[str, Any]:
    """`build(*columns)` arma la consulta con joins y filtros; se usa para contar y para listar."""
    total = (await session.execute(build(func.count(Order.id)))).scalar_one()
    rows = (await session.execute(build().order_by(Order.created_at.desc(), Order.id).limit(limit).offset(offset))).all()
    return {
        "items": [_order_summary(*row) for row in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


router = APIRouter(prefix="/api/v1")


async def _authorized_purchase(
    session: AsyncSession, user: CurrentUser, context: DatasetContext, order_id: str
) -> tuple[Order, OrderCustomer | None, OrderBilling | None]:
    identifier = _order_id(order_id)
    order = await session.get(Order, identifier)
    customer = await session.get(OrderCustomer, identifier)
    # 404 (no 403) si no es suyo: no revelamos que el pedido existe ni quién lo hizo.
    allowed = user.is_admin or (customer is not None and customer.user_id == user.id)
    if order is None or order.dataset_id != context.dataset_id or not allowed:
        raise ApiError(404, "NOT_FOUND", "Order not found")
    return order, customer, await session.get(OrderBilling, identifier)


@router.get("/orders/{order_id}/customer")
async def get_order_customer(
    order_id: str,
    user: CurrentUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    context: DatasetContext = Depends(dataset_context),
) -> dict[str, Any]:
    _, customer, _ = await _authorized_purchase(session, user, context, order_id)
    if customer is None:
        raise ApiError(404, "NOT_FOUND", "Order has no registered customer")
    return {"order_id": str(customer.order_id), **customer_view(customer)}


@router.get("/orders/{order_id}/invoice")
async def get_order_invoice(
    order_id: str,
    request: Request,
    user: CurrentUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    context: DatasetContext = Depends(dataset_context),
) -> dict[str, Any]:
    order, customer, billing = await _authorized_purchase(session, user, context, order_id)
    if billing is None or billing.status != ISSUED or billing.invoice_id is None:
        raise ApiError(
            409,
            "INVOICE_NOT_ISSUED",
            "The invoice has not been issued yet",
            {"billing_status": billing.status if billing else None, "error": billing.last_error if billing else None},
        )

    snapshot = order.snapshot if isinstance(order.snapshot, dict) else {}
    official = await fetch_invoice(get_settings_from_request(request), billing.invoice_id)
    verified = (
        official is not None
        and str(official.get("id")) == str(billing.invoice_id)
        and str(official.get("order_id")) == str(order.id)
        and official.get("total_cents") == order.total_cents
        and official.get("status") == "issued"
    )
    source_items = official.get("items") if verified and isinstance(official.get("items"), list) else snapshot.get("items", [])
    items = [
        {
            "product_id": item.get("product_id"),
            "name": item.get("name"),
            "quantity": item.get("quantity"),
            "unit_price_cents": item.get("unit_price_cents"),
            "line_total_cents": int(item.get("unit_price_cents") or 0) * int(item.get("quantity") or 0),
        }
        for item in source_items
        if isinstance(item, dict)
    ]
    taxable, igv = igv_split(order.total_cents)
    return {
        "invoice_id": str(billing.invoice_id),
        "invoice_number": billing.invoice_number,
        "issued_at": official.get("created_at") if verified else _iso(billing.updated_at),
        "status": "issued",
        "verified": verified,
        "currency": "PEN",
        "issuer": {"name": STORE_NAME, "client_id": official.get("issuer_id") if verified else None},
        "customer": {"full_name": customer.full_name, "email": customer.email} if customer else None,
        "order": {"id": str(order.id), "created_at": iso8601(order.created_at)},
        "items": items,
        "totals": {
            "taxable_cents": taxable,
            "igv_cents": igv,
            "igv_rate": float(IGV_RATE),
            "total_cents": order.total_cents,
        },
        "note": INVOICE_NOTE,
    }


@router.get("/me/orders")
async def my_orders(
    user: CurrentUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    context: DatasetContext = Depends(dataset_context),
    billing: BillingFilter | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=100000),
) -> dict[str, Any]:
    def build(*columns):
        query = _apply_filters(_purchases_query(context.dataset_id, *columns), billing, None)
        return query.where(OrderCustomer.user_id == user.id)

    return await _page(session, build, limit, offset)


@router.get("/admin/orders")
async def admin_orders(
    admin: CurrentUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
    context: DatasetContext = Depends(dataset_context),
    billing: BillingFilter | None = Query(default=None),
    q: str | None = Query(default=None, max_length=80),
    limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0, le=100000),
) -> dict[str, Any]:
    search = " ".join(q.split()) if q else None

    def build(*columns):
        return _apply_filters(_purchases_query(context.dataset_id, *columns), billing, search)

    return await _page(session, build, limit, offset)


@router.get("/admin/summary")
async def admin_summary(
    admin: CurrentUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
    context: DatasetContext = Depends(dataset_context),
) -> dict[str, Any]:
    orders, sales = (
        await session.execute(
            select(func.count(Order.id), func.coalesce(func.sum(Order.total_cents), 0)).where(
                Order.dataset_id == context.dataset_id
            )
        )
    ).one()
    by_status = dict(
        (
            await session.execute(
                select(OrderBilling.status, func.count())
                .where(OrderBilling.dataset_id == context.dataset_id)
                .group_by(OrderBilling.status)
            )
        ).all()
    )
    customers, with_account = (
        await session.execute(
            select(func.count(distinct(OrderCustomer.user_id)), func.count(OrderCustomer.order_id)).where(
                OrderCustomer.dataset_id == context.dataset_id
            )
        )
    ).one()
    return {
        "orders": orders,
        "sales_cents": int(sales),
        "invoices": {status: int(by_status.get(status, 0)) for status in (ISSUED, PENDING, FAILED)},
        "customers": customers,
        "orders_without_account": orders - with_account,
    }


@router.post("/admin/orders/{order_id}/billing/retry")
async def admin_retry_billing(
    order_id: str,
    admin: CurrentUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
    context: DatasetContext = Depends(dataset_context),
) -> dict[str, Any]:
    identifier = _order_id(order_id)
    async with session.begin():
        row = await session.get(OrderBilling, identifier, with_for_update=True)
        if row is None or row.dataset_id != context.dataset_id:
            raise ApiError(404, "NOT_FOUND", "Order not found")
        if row.status != FAILED:
            raise ApiError(409, "BILLING_NOT_FAILED", "Only failed billing can be retried")
        # Igual que `python -m app.billing retry`: vuelve a 'pending' y el worker la reenvía
        # con el mismo cuerpo y la misma Idempotency-Key (no se duplica la factura).
        await session.execute(
            update(OrderBilling)
            .where(OrderBilling.order_id == identifier, OrderBilling.status == FAILED)
            .values(status=PENDING, last_error=None, updated_at=utcnow())
        )
    refreshed = await session.get(OrderBilling, identifier, populate_existing=True)
    return billing_view(refreshed) if refreshed else {"order_id": str(identifier), "status": PENDING}
