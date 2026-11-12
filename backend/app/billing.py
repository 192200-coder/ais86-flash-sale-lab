"""Adaptador del microservicio de facturación (Semana 11).

Flujo: el pedido se confirma y se guarda junto con una tarea `order_billing` en estado
`pending` (misma transacción local, sin llamadas remotas). El worker toma las tareas
pendientes y llama a POST {BILLING_BASE_URL}/invoices con el snapshot persistido del
pedido. Un fallo de facturación nunca revierte el pedido: la tarea queda `failed` y se
recupera con un reintento manual que reenvía el mismo cuerpo y la misma Idempotency-Key.

Reintento manual (dentro del contenedor worker):
    python -m app.billing status
    python -m app.billing retry ORDER_ID
    python -m app.billing retry --failed
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import uuid
from datetime import datetime
from typing import Any

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import DateTime, ForeignKey, Integer, String, Uuid, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import Mapped, mapped_column

from .config import Settings
from .db import Base, utcnow
from .models import Order
from .security import ApiError, DatasetContext, dataset_context, get_session

logger = logging.getLogger(__name__)

PENDING, ISSUED, FAILED = "pending", "issued", "failed"
TRANSIENT_STATUS = {429, 500, 502, 503, 504}


class OrderBilling(Base):
    """Estado local de facturación. Independiente de notification_status."""

    __tablename__ = "order_billing"

    order_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("orders.id", ondelete="CASCADE"), primary_key=True
    )
    dataset_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=PENDING, index=True)
    invoice_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    invoice_number: Mapped[str | None] = mapped_column(String(80), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_error: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


def invoice_request(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Transforma el snapshot persistido de S09 al contrato exacto de facturación."""
    return {
        "order_id": str(snapshot["id"]).lower(),
        "currency": "PEN",
        "items": [
            {
                "product_id": item["product_id"],
                "name": item["name"],
                "quantity": item["quantity"],
                "unit_price_cents": item["unit_price_cents"],
            }
            for item in snapshot["items"]
        ],
        "total_cents": snapshot["total_cents"],
    }


class BillingFailure(Exception):
    def __init__(self, code: str, transient: bool) -> None:
        super().__init__(code)
        self.code = code
        self.transient = transient


def _error_code(response: httpx.Response) -> str:
    try:
        code = response.json()["error"]["code"]
        if isinstance(code, str) and code.replace("_", "").isalnum():
            return f"{response.status_code} {code}"[:120]
    except Exception:
        pass
    return f"HTTP_{response.status_code}"


async def send_invoice(client: httpx.AsyncClient, settings: Settings, body: dict[str, Any]) -> dict[str, Any]:
    try:
        response = await client.post(
            settings.billing_base_url.rstrip("/") + "/invoices",
            json=body,
            headers={
                "X-Billing-Token": settings.billing_token_value(),
                "Idempotency-Key": body["order_id"],
            },
        )
    except httpx.TimeoutException:
        # Un timeout no prueba que la factura no exista: el reintento con la misma clave la recupera.
        raise BillingFailure("TIMEOUT", transient=True) from None
    except httpx.TransportError:
        raise BillingFailure("NETWORK_ERROR", transient=True) from None

    if response.status_code in (200, 201):
        try:
            invoice = response.json()
            valid = (
                invoice.get("order_id") == body["order_id"]
                and invoice.get("status") == "issued"
                and invoice.get("total_cents") == body["total_cents"]
            )
            uuid.UUID(str(invoice.get("id")))
        except Exception:
            valid = False
        if not valid:
            raise BillingFailure("INVALID_RESPONSE", transient=False)
        return invoice
    raise BillingFailure(_error_code(response), transient=response.status_code in TRANSIENT_STATUS)


async def bill_order(client: httpx.AsyncClient, settings: Settings, body: dict[str, Any]) -> tuple[dict | None, str | None, int]:
    """Un intento + como máximo dos reintentos automáticos, solo ante fallos transitorios."""
    attempts = 0
    for attempt in range(settings.billing_max_attempts):
        attempts += 1
        try:
            return await send_invoice(client, settings, body), None, attempts
        except BillingFailure as failure:
            if not failure.transient or attempt == settings.billing_max_attempts - 1:
                return None, failure.code, attempts
            await asyncio.sleep(1.0 * (attempt + 1))
    return None, "UNKNOWN", attempts


async def process_billing_batch(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    client: httpx.AsyncClient,
    limit: int = 10,
) -> int:
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(OrderBilling.order_id, Order.snapshot)
                .join(Order, Order.id == OrderBilling.order_id)
                .where(OrderBilling.status == PENDING)
                .order_by(OrderBilling.created_at)
                .limit(limit)
            )
        ).all()

    for order_id, snapshot in rows:
        # La llamada remota se hace FUERA de cualquier transacción de pedido o stock.
        invoice, error, attempts = await bill_order(client, settings, invoice_request(snapshot))
        values: dict[str, Any] = {"updated_at": utcnow(), "attempts": OrderBilling.attempts + attempts}
        if invoice is not None:
            values |= {"status": ISSUED, "invoice_id": uuid.UUID(invoice["id"]),
                       "invoice_number": str(invoice.get("number", ""))[:80], "last_error": None}
            logger.info("billing issued order=%s", order_id)
        else:
            values |= {"status": FAILED, "last_error": error}
            logger.warning("billing failed order=%s error=%s", order_id, error)
        async with session_factory() as session:
            async with session.begin():
                await session.execute(
                    update(OrderBilling)
                    .where(OrderBilling.order_id == order_id, OrderBilling.status == PENDING)
                    .values(**values)
                )
    return len(rows)


async def billing_loop(session_factory: async_sessionmaker[AsyncSession], settings: Settings) -> None:
    if not settings.billing_configured():
        logger.warning("billing not configured: set BILLING_BASE_URL and BILLING_TOKEN; orders stay pending")
        return
    async with httpx.AsyncClient(timeout=settings.billing_timeout_seconds, trust_env=True) as client:
        while True:
            try:
                await process_billing_batch(session_factory, settings, client)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("billing loop error type=%s", type(exc).__name__)
            await asyncio.sleep(settings.billing_poll_seconds)


# --- Consulta para el usuario (ruta nueva; no cambia el JSON público de pedidos) ---

router = APIRouter()


def billing_view(row: OrderBilling) -> dict[str, Any]:
    return {
        "order_id": str(row.order_id),
        "status": row.status,
        "invoice_id": str(row.invoice_id) if row.invoice_id else None,
        "invoice_number": row.invoice_number,
        "error": row.last_error,
    }


@router.get("/api/v1/orders/{order_id}/billing")
async def get_order_billing(
    order_id: str,
    session: AsyncSession = Depends(get_session),
    context: DatasetContext = Depends(dataset_context),
) -> dict[str, Any]:
    try:
        identifier = uuid.UUID(order_id)
    except (ValueError, AttributeError, TypeError):
        raise ApiError(404, "NOT_FOUND", "Order not found") from None
    row = await session.get(OrderBilling, identifier)
    if row is None or row.dataset_id != context.dataset_id:
        raise ApiError(404, "NOT_FOUND", "Order not found")
    return billing_view(row)


# --- Reintento manual desde la terminal ---

async def _cli(args: argparse.Namespace) -> int:
    from .config import get_settings
    from .db import Database

    database = Database(get_settings())
    try:
        async with database.session_factory() as session:
            async with session.begin():
                if args.command == "retry":
                    query = update(OrderBilling).where(OrderBilling.status == FAILED)
                    if not args.failed:
                        query = query.where(OrderBilling.order_id == uuid.UUID(args.order_id))
                    result = await session.execute(
                        query.values(status=PENDING, last_error=None, updated_at=utcnow())
                    )
                    print(f"{result.rowcount} facturación(es) vuelven a 'pending'; el worker las reenvía con la misma clave.")
                    return 0
                rows = (await session.execute(
                    select(OrderBilling).order_by(OrderBilling.created_at.desc()).limit(args.limit)
                )).scalars().all()
                for row in rows:
                    print(f"{row.order_id}  {row.status:8}  {row.invoice_number or '-':45}  intentos={row.attempts}  {row.last_error or ''}")
                return 0
    finally:
        await database.close()


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m app.billing")
    sub = parser.add_subparsers(dest="command", required=True)
    status = sub.add_parser("status", help="lista las últimas facturaciones")
    status.add_argument("--limit", type=int, default=20)
    retry = sub.add_parser("retry", help="reintenta una facturación fallida")
    group = retry.add_mutually_exclusive_group(required=True)
    group.add_argument("order_id", nargs="?")
    group.add_argument("--failed", action="store_true", help="reintenta todas las fallidas")
    raise SystemExit(asyncio.run(_cli(parser.parse_args())))


if __name__ == "__main__":
    main()
