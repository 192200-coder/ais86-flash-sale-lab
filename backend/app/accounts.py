"""Comprador del pedido, "Mis pedidos" y panel de administración (Semana 12).

Los datos de la persona autenticada se guardan en una tabla aparte (`order_customers`),
en la misma transacción que el pedido. El JSON público del pedido, el evento CloudEvents y
la petición al microservicio de facturación NO cambian: el comprador solo se expone en rutas
nuevas que exigen sesión.

Permisos:
  - anónimo  : ver catálogo y consultar un pedido por su ID (contrato S09); NO puede comprar.
  - cliente  : comprar, ver "Mis pedidos" y el comprador de SUS pedidos.
  - admin    : todo lo anterior + ver todos los pedidos con su comprador y reintentar
               facturaciones fallidas.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import DateTime, ForeignKey, String, Uuid, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from .auth import CurrentUser, require_admin, require_user
from .billing import FAILED, PENDING, OrderBilling, billing_view
from .db import Base, utcnow
from .events import iso8601
from .models import Order
from .security import ApiError, DatasetContext, dataset_context, get_session


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


def _order_id(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        raise ApiError(404, "NOT_FOUND", "Order not found") from None


def _billing_summary(row: OrderBilling | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "status": row.status,
        "invoice_number": row.invoice_number,
        "error": row.last_error,
        "attempts": row.attempts,
    }


def _order_summary(order: Order, customer: OrderCustomer | None, billing: OrderBilling | None) -> dict[str, Any]:
    items = order.snapshot.get("items", []) if isinstance(order.snapshot, dict) else []
    return {
        "id": str(order.id),
        "created_at": iso8601(order.created_at),
        "total_cents": order.total_cents,
        "notification_status": order.notification_status,
        "items": [{"name": item.get("name"), "quantity": item.get("quantity")} for item in items],
        "customer": customer_view(customer) if customer else None,
        "billing": _billing_summary(billing),
    }


router = APIRouter(prefix="/api/v1")


@router.get("/orders/{order_id}/customer")
async def get_order_customer(
    order_id: str,
    user: CurrentUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    context: DatasetContext = Depends(dataset_context),
) -> dict[str, Any]:
    row = await session.get(OrderCustomer, _order_id(order_id))
    # 404 (no 403) si no es suyo: no revelamos que el pedido tiene comprador.
    if row is None or row.dataset_id != context.dataset_id or (row.user_id != user.id and not user.is_admin):
        raise ApiError(404, "NOT_FOUND", "Order not found")
    return {"order_id": str(row.order_id), **customer_view(row)}


@router.get("/me/orders")
async def my_orders(
    user: CurrentUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    context: DatasetContext = Depends(dataset_context),
    limit: int = Query(default=30, ge=1, le=100),
) -> dict[str, Any]:
    rows = (
        await session.execute(
            select(Order, OrderCustomer, OrderBilling)
            .join(OrderCustomer, OrderCustomer.order_id == Order.id)
            .outerjoin(OrderBilling, OrderBilling.order_id == Order.id)
            .where(OrderCustomer.user_id == user.id, Order.dataset_id == context.dataset_id)
            .order_by(Order.created_at.desc())
            .limit(limit)
        )
    ).all()
    return {"items": [_order_summary(order, customer, billing) for order, customer, billing in rows]}


@router.get("/admin/orders")
async def admin_orders(
    admin: CurrentUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
    context: DatasetContext = Depends(dataset_context),
    limit: int = Query(default=50, ge=1, le=200),
) -> dict[str, Any]:
    rows = (
        await session.execute(
            select(Order, OrderCustomer, OrderBilling)
            .outerjoin(OrderCustomer, OrderCustomer.order_id == Order.id)
            .outerjoin(OrderBilling, OrderBilling.order_id == Order.id)
            .where(Order.dataset_id == context.dataset_id)
            .order_by(Order.created_at.desc())
            .limit(limit)
        )
    ).all()
    return {"items": [_order_summary(order, customer, billing) for order, customer, billing in rows]}


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
