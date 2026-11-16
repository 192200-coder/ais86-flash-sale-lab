"""Semana 12: factura, seguimiento y permisos de compras (sin red ni base de datos)."""
import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import SecretStr

from app import accounts
from app.accounts import OrderCustomer, get_order_invoice, igv_split, timeline
from app.auth import CurrentUser
from app.billing import OrderBilling
from app.config import Settings
from app.models import Notification, Order
from app.security import ApiError, DatasetContext

NOW = datetime(2026, 11, 16, 15, 0, tzinfo=timezone.utc)
PUBLIC = DatasetContext(dataset_id="public", notification_delay_ms=0, run_id=None)
OWNER = CurrentUser(id=uuid.uuid4(), email="ana@example.com", full_name="Ana Cliente", role="cliente")
OTHER = CurrentUser(id=uuid.uuid4(), email="bruno@example.com", full_name="Bruno Cliente", role="cliente")
ADMIN = CurrentUser(id=uuid.uuid4(), email="admin@example.com", full_name="Admin", role="admin")


class FakeRequest:
    class app:  # noqa: N801
        class state:  # noqa: N801
            settings = Settings(
                database_url="postgresql://user:pass@localhost:5432/flash",
                redis_url="redis://localhost:6379/0",
                lab_key=SecretStr("l" * 40),
            )


class FakeSession:
    def __init__(self, *rows) -> None:
        self.rows = {(type(row), row.order_id if hasattr(row, "order_id") and not isinstance(row, Order) else row.id): row for row in rows}

    async def get(self, model, key, **_):
        return self.rows.get((model, key))


def purchase(billing_status="issued", with_customer=True, total=129900):
    order_id = uuid.uuid4()
    invoice_id = uuid.uuid4()
    order = Order(
        id=order_id,
        dataset_id="public",
        total_cents=total,
        notification_status="sent",
        created_at=NOW,
        snapshot={
            "id": str(order_id),
            "items": [{"product_id": "nova-headphones", "name": "Nova Headphones", "quantity": 1, "unit_price_cents": total}],
            "total_cents": total,
        },
    )
    billing = OrderBilling(
        order_id=order_id,
        dataset_id="public",
        status=billing_status,
        invoice_id=invoice_id if billing_status == "issued" else None,
        invoice_number=f"DEMO-{invoice_id}" if billing_status == "issued" else None,
        last_error="503 DEPENDENCY_UNAVAILABLE" if billing_status == "failed" else None,
        attempts=1,
        created_at=NOW,
        updated_at=NOW + timedelta(seconds=3),
    )
    rows = [order, billing]
    if with_customer:
        rows.append(OrderCustomer(order_id=order_id, dataset_id="public", user_id=OWNER.id,
                                  email=OWNER.email, full_name=OWNER.full_name, created_at=NOW))
    official = {
        "id": str(invoice_id),
        "issuer_id": "tienda-a",
        "order_id": str(order_id),
        "currency": "PEN",
        "items": order.snapshot["items"],
        "total_cents": total,
        "status": "issued",
        "created_at": "2026-11-16T15:00:03.123Z",
    }
    return order, FakeSession(*rows), official


def invoice(session, user, order, monkeypatch, official):
    async def fake_fetch(settings, invoice_id):
        return official

    monkeypatch.setattr(accounts, "fetch_invoice", fake_fetch)
    return asyncio.run(get_order_invoice(str(order.id), FakeRequest(), user, session, PUBLIC))


def test_igv_included_in_price() -> None:
    assert igv_split(118) == (100, 18)
    taxable, igv = igv_split(129900)
    assert taxable == 110085 and igv == 19815 and taxable + igv == 129900
    assert igv_split(0) == (0, 0)


def test_timeline_states() -> None:
    order, session, _ = purchase("issued")
    billing = session.rows[(OrderBilling, order.id)]
    notification = Notification(order_id=order.id, dataset_id="public", event_id=uuid.uuid4(), created_at=NOW + timedelta(seconds=1))
    steps = {step["step"]: step for step in timeline(order, notification, billing)}
    assert steps["confirmed"]["state"] == "done"
    assert steps["notification"]["state"] == "done" and steps["notification"]["at"]
    assert steps["invoice"]["state"] == "done" and steps["invoice"]["detail"].startswith("DEMO-")
    failed_order, failed_session, _ = purchase("failed")
    failed = timeline(failed_order, None, failed_session.rows[(OrderBilling, failed_order.id)])[2]
    assert failed["state"] == "failed" and failed["detail"] == "503 DEPENDENCY_UNAVAILABLE"
    assert timeline(failed_order, None, None)[2]["state"] == "none"


def test_owner_gets_verified_invoice_with_buyer_and_igv(monkeypatch) -> None:
    order, session, official = purchase()
    body = invoice(session, OWNER, order, monkeypatch, official)
    assert body["verified"] is True
    assert body["invoice_number"] == f"DEMO-{official['id']}"
    assert body["issued_at"] == official["created_at"]
    assert body["customer"] == {"full_name": "Ana Cliente", "email": "ana@example.com"}
    assert body["issuer"]["client_id"] == "tienda-a"
    assert body["items"][0]["line_total_cents"] == 129900
    assert body["totals"] == {"taxable_cents": 110085, "igv_cents": 19815, "igv_rate": 0.18, "total_cents": 129900}
    assert "SUNAT" in body["note"]


def test_other_client_cannot_see_invoice(monkeypatch) -> None:
    order, session, official = purchase()
    with pytest.raises(ApiError) as caught:
        invoice(session, OTHER, order, monkeypatch, official)
    assert caught.value.status_code == 404


def test_admin_sees_any_invoice_even_without_account(monkeypatch) -> None:
    order, session, official = purchase(with_customer=False)
    body = invoice(session, ADMIN, order, monkeypatch, official)
    assert body["verified"] is True and body["customer"] is None
    with pytest.raises(ApiError):
        invoice(session, OWNER, order, monkeypatch, official)


def test_not_issued_invoice_is_not_invented(monkeypatch) -> None:
    for status in ("pending", "failed"):
        order, session, official = purchase(status)
        with pytest.raises(ApiError) as caught:
            invoice(session, OWNER, order, monkeypatch, official)
        assert caught.value.status_code == 409
        assert caught.value.code == "INVOICE_NOT_ISSUED"
        assert caught.value.details["billing_status"] == status


def test_unverified_when_microservice_down_or_mismatch(monkeypatch) -> None:
    order, session, official = purchase()
    body = invoice(session, OWNER, order, monkeypatch, None)
    assert body["verified"] is False and body["totals"]["total_cents"] == 129900
    tampered = dict(official, total_cents=1)
    assert invoice(session, OWNER, order, monkeypatch, tampered)["verified"] is False
