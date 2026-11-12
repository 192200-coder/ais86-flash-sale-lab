import asyncio
import json
import uuid

import httpx
import pytest

from app import billing
from app.config import Settings

ORDER_ID = str(uuid.uuid4())
SNAPSHOT = {
    "id": ORDER_ID,
    "status": "confirmed",
    "notification_status": "pending",
    "items": [{"product_id": "arc-mouse", "name": "Arc Mouse", "quantity": 2, "unit_price_cents": 49900}],
    "total_cents": 99800,
    "created_at": "2026-11-11T20:00:00Z",
}


def settings(**overrides):
    values = {
        "database_url": "postgresql://u:p@localhost/db",
        "redis_url": "redis://localhost:6379/0",
        "lab_key": "k" * 32,
        "billing_base_url": "https://abc.supabase.co/functions/v1/billing",
        "billing_token": "a" * 64,
    }
    values.update(overrides)
    return Settings(**values)


def invoice_for(body):
    invoice_id = str(uuid.uuid4())
    return {**body, "id": invoice_id, "number": f"DEMO-{invoice_id}", "issuer_id": "tienda-a",
            "status": "issued", "created_at": "2026-11-11T20:00:01Z"}


def run_bill(handler, **overrides):
    calls = []

    def recorder(request):
        calls.append(request)
        return handler(request, len(calls))

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(recorder)) as client:
            return await billing.bill_order(client, settings(**overrides), billing.invoice_request(SNAPSHOT))

    original_sleep = asyncio.sleep
    billing.asyncio.sleep = lambda *_: original_sleep(0)
    try:
        return asyncio.run(go()), calls
    finally:
        billing.asyncio.sleep = original_sleep


def test_invoice_request_follows_contract():
    body = billing.invoice_request(SNAPSHOT)
    assert set(body) == {"order_id", "currency", "items", "total_cents"}
    assert set(body["items"][0]) == {"product_id", "name", "quantity", "unit_price_cents"}
    assert body["order_id"] == ORDER_ID and body["currency"] == "PEN" and body["total_cents"] == 99800


def test_success_sends_token_and_idempotency_key():
    (invoice, error, attempts), calls = run_bill(
        lambda req, n: httpx.Response(201, json=invoice_for(json.loads(req.content))))
    assert error is None and attempts == 1 and invoice["status"] == "issued"
    request = calls[0]
    assert str(request.url) == "https://abc.supabase.co/functions/v1/billing/invoices"
    assert request.headers["Idempotency-Key"] == ORDER_ID
    assert request.headers["X-Billing-Token"] == "a" * 64


def test_timeout_then_replay_recovers_same_invoice():
    saved = {}

    def handler(req, n):
        if n == 1:
            saved["invoice"] = invoice_for(json.loads(req.content))
            raise httpx.ReadTimeout("slow", request=req)
        return httpx.Response(200, json=saved["invoice"], headers={"X-Idempotent-Replay": "true"})

    (invoice, error, attempts), calls = run_bill(handler)
    assert error is None and attempts == 2 and invoice["id"] == saved["invoice"]["id"]
    assert calls[0].content == calls[1].content


def test_conflict_is_not_retried():
    (invoice, error, attempts), _ = run_bill(lambda req, n: httpx.Response(
        409, json={"error": {"code": "IDEMPOTENCY_CONFLICT", "message": "x"}}))
    assert invoice is None and attempts == 1 and error == "409 IDEMPOTENCY_CONFLICT"


def test_unauthorized_is_not_retried():
    (invoice, error, attempts), _ = run_bill(lambda req, n: httpx.Response(
        401, json={"error": {"code": "UNAUTHORIZED", "message": "x"}}))
    assert invoice is None and attempts == 1 and error == "401 UNAUTHORIZED"


def test_transient_failures_stop_after_two_retries():
    (invoice, error, attempts), calls = run_bill(lambda req, n: httpx.Response(503, text="gateway"))
    assert invoice is None and attempts == 3 and len(calls) == 3 and error == "HTTP_503"


def test_response_for_another_order_is_rejected():
    (invoice, error, _), _ = run_bill(lambda req, n: httpx.Response(
        201, json={**invoice_for(json.loads(req.content)), "order_id": str(uuid.uuid4())}))
    assert invoice is None and error == "INVALID_RESPONSE"


@pytest.mark.parametrize("url,token,expected", [
    ("https://abc.supabase.co/functions/v1/billing", "a" * 64, True),
    ("https://abc.supabase.co/functions/v1/billing/", "a" * 64, True),
    ("", "a" * 64, False),
    ("https://abc.supabase.co/functions/v1/billing", "", False),
    ("http://abc.supabase.co/functions/v1/billing", "a" * 64, False),
    ("https://abc.supabase.co/functions/v1/billing/billing/x", "a" * 64, False),
])
def test_billing_configured(url, token, expected):
    assert settings(billing_base_url=url, billing_token=token).billing_configured() is expected
