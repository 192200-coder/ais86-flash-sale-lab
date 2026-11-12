"""Comprueba la integración S09 -> microservicio de facturación (Semana 11).

Uso:
    docker compose exec api python /app/tools/check_billing.py --target http://127.0.0.1:8000
Confirma un pedido en un dataset de prueba aislado, espera a que el worker lo facture
y comprueba que repetir el pedido no genera otra factura. No muestra tokens.
"""
import argparse
import json
import os
import sys
import time
import uuid
from urllib.error import HTTPError
from urllib.request import Request, urlopen

parser = argparse.ArgumentParser()
parser.add_argument("--target", default="http://127.0.0.1:8000")
parser.add_argument("--wait", type=float, default=40.0, help="segundos máximos esperando la factura")
args = parser.parse_args()
base = args.target.rstrip("/")
key = os.environ.get("LAB_KEY", "")
if not key:
    sys.exit("Falta LAB_KEY. Ejecuta: docker compose exec api python /app/tools/check_billing.py")
if not os.environ.get("BILLING_TOKEN") or not os.environ.get("BILLING_BASE_URL"):
    print("AVISO | BILLING_BASE_URL o BILLING_TOKEN no llegaron al contenedor: revisa .env y recrea api y worker.")
failures = []


def request(method, path, body=None, run=None, idem=None):
    headers = {"Content-Type": "application/json", "X-Lab-Key": key}
    if run:
        headers["X-Lab-Run"] = run
    if idem:
        headers["Idempotency-Key"] = idem
    data = None if body is None else json.dumps(body).encode()
    try:
        with urlopen(Request(base + path, data=data, headers=headers, method=method), timeout=15) as response:
            status, content = response.status, response.read(1024 * 1024)
    except HTTPError as exc:
        status, content = exc.code, exc.read(1024 * 1024)
    return status, json.loads(content) if content else {}


def check(condition, label):
    print(("PASA | " if condition else "FALLA | ") + label)
    if not condition:
        failures.append(label)


def wait_billing(run, order_id):
    deadline = time.monotonic() + args.wait
    while True:
        status, billing = request("GET", f"/api/v1/orders/{order_id}/billing", run=run)
        if status == 200 and billing["status"] != "pending":
            return billing
        if time.monotonic() > deadline:
            return billing
        time.sleep(1.0)


status, data = request("POST", "/_lab/runs", {"stock": 20, "notification_delay_ms": 0})
assert status == 201, f"No se pudo crear el dataset de prueba ({status})"
run = data["run_id"]
try:
    body = {"items": [{"product_id": "arc-mouse", "quantity": 2}, {"product_id": "flux-hub", "quantity": 1}]}
    idem = uuid.uuid4().hex
    start = time.monotonic()
    status, order = request("POST", "/api/v1/orders", body, run, idem=idem)
    elapsed = time.monotonic() - start
    check(status == 201 and elapsed < 2.0, f"Pedido confirmado sin esperar a facturación ({elapsed:.2f} s)")
    check("billing" not in order, "El JSON público del pedido no cambió")

    billing = wait_billing(run, order["id"])
    check(billing.get("status") == "issued",
          f"Facturación emitida (estado: {billing.get('status')}, error: {billing.get('error')})")
    check(billing.get("invoice_number") == f"DEMO-{billing.get('invoice_id')}", "Número de comprobante DEMO-<id>")
    if billing.get("status") == "issued":
        print(f"       pedido {order['id']} -> comprobante {billing['invoice_number']}")

    status, again = request("POST", "/api/v1/orders", body, run, idem=idem)
    check(status == 201 and again["id"] == order["id"], "Reintento del pedido devuelve el mismo pedido")
    time.sleep(3)
    status, same = request("GET", f"/api/v1/orders/{order['id']}/billing", run=run)
    check(same.get("invoice_id") == billing.get("invoice_id"), "Sigue siendo el mismo comprobante (sin duplicar)")

    status, persisted = request("GET", "/api/v1/orders/" + order["id"], run=run)
    check(status == 200 and persisted["status"] == "confirmed", "El pedido sigue confirmado")
    status, _ = request("GET", f"/api/v1/orders/{uuid.uuid4()}/billing", run=run)
    check(status == 404, "Facturación de un pedido inexistente: 404")
finally:
    request("DELETE", "/_lab/runs/" + run)

total = 8
print(f"\nFacturación: {total - len(failures)}/{total}.")
sys.exit(1 if failures else 0)
