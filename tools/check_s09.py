"""Comprueba las tareas A, B y C de Semana 9 contra la API en ejecución.

Uso (igual que el smoke):
    docker compose exec api python /app/tools/check_s09.py --target http://127.0.0.1:8000
Crea datasets de prueba aislados (/_lab/runs) y los borra al terminar.
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
args = parser.parse_args()
base = args.target.rstrip("/")
key = os.environ.get("LAB_KEY", "")
if not key:
    sys.exit("Falta LAB_KEY. Ejecuta: docker compose exec api python /app/tools/check_s09.py")
failures = []


def request(method, path, body=None, run=None, idem=None, raw=None):
    headers = {"Content-Type": "application/json", "X-Lab-Key": key}
    if run:
        headers["X-Lab-Run"] = run
    if idem:
        headers["Idempotency-Key"] = idem
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
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


def new_run(delay_ms=0):
    status, data = request("POST", "/_lab/runs", {"stock": 20, "notification_delay_ms": delay_ms})
    assert status == 201, f"No se pudo crear el dataset de prueba ({status})"
    return data["run_id"]


def wait_run(run, condition, seconds=10):
    deadline = time.monotonic() + seconds
    while True:
        status, state = request("GET", "/_lab/runs/" + run)
        if status == 200 and condition(state):
            return state
        if time.monotonic() > deadline:
            return state
        time.sleep(0.3)


runs = []
try:
    # Tarea A: cantidad entera estricta 1..5
    run = new_run()
    runs.append(run)
    for label, quantity in [("texto \"1\"", "1"), ("booleano true", True), ("decimal 1.5", 1.5),
                            ("decimal 2.0", 2.0), ("cero", 0), ("seis", 6), ("null", None)]:
        status, body = request("POST", "/api/v1/orders", {"items": [{"product_id": "arc-mouse", "quantity": quantity}]},
                               run, idem=uuid.uuid4().hex)
        check(status == 422 and body.get("error", {}).get("code") == "VALIDATION_ERROR",
              f"A: rechaza cantidad {label} con 422 VALIDATION_ERROR")
    status, order = request("POST", "/api/v1/orders", {"items": [{"product_id": "arc-mouse", "quantity": 2}]},
                            run, idem=uuid.uuid4().hex)
    check(status == 201 and order["total_cents"] == 2 * 49900, "A: acepta cantidad entera 2")

    # Tarea B: evento CloudEvents completo, con data.total_cents
    state = wait_run(run, lambda s: any(e["payload"]["data"]["order_id"] == order["id"]
                                        and e["status"] in ("processed", "rejected") for e in s["events"]))
    events = [e for e in state["events"] if e["payload"]["data"]["order_id"] == order["id"]]
    event = events[0] if events else {"payload": {"data": {}}, "status": "ausente"}
    data = event["payload"].get("data", {})
    check(event["status"] == "processed", f"B: evento procesado, no rechazado (estado: {event['status']})")
    check(data.get("total_cents") == order["total_cents"], "B: data.total_cents coincide con el pedido")
    check(event["payload"].get("type") == "pe.unamba.flash.order.created.v1"
          and event["payload"].get("specversion") == "1.0", "B: sobre CloudEvents con tipo y versión")

    # Tarea C: la respuesta HTTP no espera a la notificación
    slow = new_run(delay_ms=2000)
    runs.append(slow)
    start = time.monotonic()
    status, order = request("POST", "/api/v1/orders", {"items": [{"product_id": "flux-hub", "quantity": 1}]},
                            slow, idem=uuid.uuid4().hex)
    elapsed = time.monotonic() - start
    check(status == 201 and elapsed < 1.0, f"C: confirma sin esperar la notificación ({elapsed:.2f} s con retraso de 2 s)")
    check(order.get("notification_status") == "pending", "C: la respuesta no declara 'sent' antes de tiempo")
    status, now = request("GET", "/api/v1/orders/" + order["id"], run=slow)
    check(now.get("notification_status") == "pending", "C: recién creado, la consulta muestra 'pending'")
    deadline = time.monotonic() + 10
    while now.get("notification_status") == "pending" and time.monotonic() < deadline:
        time.sleep(0.3)
        status, now = request("GET", "/api/v1/orders/" + order["id"], run=slow)
    check(now.get("notification_status") == "sent", "C: después pasa a 'sent' (estado eventual)")
finally:
    for run in runs:
        request("DELETE", "/_lab/runs/" + run)

total = 15
print(f"\nSemana 9: {total - len(failures)}/{total}.")
sys.exit(1 if failures else 0)
