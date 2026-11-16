"""Comprueba el login con Supabase Auth, los roles y el comprador del pedido (Semana 12).

Uso (PowerShell, desde la carpeta del S09; las credenciales se cargan sin mostrarlas):
    $env:DEMO_USERS = ((Get-Content ..\\usuarios-demo.txt | Where-Object { $_ -notmatch '^#' }) -join ';')
    docker compose exec -e DEMO_USERS api python /app/tools/check_auth.py --target http://127.0.0.1:8000

DEMO_USERS = "correo | contraseña | rol;..." con un admin y dos clientes. Las compras se hacen
en un dataset de prueba aislado (no gasta stock de la tienda). No imprime tokens ni contraseñas.
"""
import argparse
import json
import os
import sys
import uuid
from urllib.error import HTTPError
from urllib.request import Request, urlopen

parser = argparse.ArgumentParser()
parser.add_argument("--target", default="http://127.0.0.1:8000")
args = parser.parse_args()
base = args.target.rstrip("/")
lab_key = os.environ.get("LAB_KEY", "")
if not lab_key:
    sys.exit("Falta LAB_KEY. Ejecuta el script dentro del contenedor api.")

users = {"admin": [], "cliente": []}
for entry in os.environ.get("DEMO_USERS", "").split(";"):
    parts = [part.strip() for part in entry.split("|")]
    if len(parts) == 3 and parts[2] in users:
        users[parts[2]].append((parts[0], parts[1]))
if not users["admin"] or len(users["cliente"]) < 2:
    sys.exit("Falta DEMO_USERS con 1 admin y 2 clientes (ver la cabecera de este archivo).")

failures = []
counted = []


def request(method, path, body=None, token=None, run=None, idem=None, lab=False):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if run or lab:
        headers["X-Lab-Key"] = lab_key
    if run:
        headers["X-Lab-Run"] = run
    if idem:
        headers["Idempotency-Key"] = idem
    data = None if body is None else json.dumps(body).encode()
    try:
        with urlopen(Request(base + path, data=data, headers=headers, method=method), timeout=20) as response:
            status, content = response.status, response.read(1024 * 1024)
    except HTTPError as exc:
        status, content = exc.code, exc.read(1024 * 1024)
    try:
        return status, json.loads(content) if content else {}
    except ValueError:
        return status, {}


def check(condition, label):
    counted.append(label)
    print(("PASA | " if condition else "FALLA | ") + label)
    if not condition:
        failures.append(label)


def code(body):
    return (body.get("error") or {}).get("code") if isinstance(body, dict) else None


def login(email, password):
    status, body = request("POST", "/api/v1/auth/login", {"email": email, "password": password})
    return status, body


ORDER = {"items": [{"product_id": "arc-mouse", "quantity": 1}]}

# 1. Sin sesión no se compra en la tienda pública (antes de crear nada).
status, body = request("POST", "/api/v1/orders", ORDER, idem="auth-" + uuid.uuid4().hex)
check(status == 401 and code(body) == "AUTH_REQUIRED", "Tienda pública: compra sin sesión -> 401 AUTH_REQUIRED")
status, body = request("POST", "/api/v1/orders", ORDER, token="no.es.un-jwt", idem="auth-" + uuid.uuid4().hex)
check(status == 401 and code(body) == "INVALID_TOKEN", "Token falso -> 401 INVALID_TOKEN")

# 2. Login con Supabase Auth.
status, body = login(users["cliente"][0][0], "contrasena-incorrecta-123")
check(status == 401 and code(body) == "INVALID_CREDENTIALS", "Contraseña incorrecta -> 401 INVALID_CREDENTIALS")
sessions = {}
for name, (email, password) in (("A", users["cliente"][0]), ("B", users["cliente"][1]), ("admin", users["admin"][0])):
    status, body = login(email, password)
    sessions[name] = body if status == 200 and isinstance(body.get("access_token"), str) else None
    expected = "admin" if name == "admin" else "cliente"
    role = (body.get("user") or {}).get("role") if sessions[name] else None
    check(sessions[name] is not None and role == expected, f"Login {name} ({email}) -> rol {expected}")
if not all(sessions.values()):
    print(f"\nAuth: {len(counted) - len(failures)}/{len(counted)} (no se pudo iniciar sesión; revisa DEMO_USERS y SUPABASE_* en .env).")
    sys.exit(1)
tA, tB, tAdmin = sessions["A"]["access_token"], sessions["B"]["access_token"], sessions["admin"]["access_token"]
nameA, emailA = sessions["A"]["user"]["full_name"], sessions["A"]["user"]["email"]

status, body = request("POST", "/api/v1/auth/signup",
                       {"full_name": "Eve", "email": "eve@example.com", "password": "12345678", "role": "admin"})
check(status == 422, "Registro no permite elegir el rol (campo 'role' rechazado)")

# 3. Compras en un dataset aislado.
status, data = request("POST", "/_lab/runs", {"stock": 20, "notification_delay_ms": 0}, lab=True)
if status != 201:
    sys.exit(f"No se pudo crear el dataset de prueba (HTTP {status}).")
run = data["run_id"]
try:
    status, order = request("POST", "/api/v1/orders", ORDER, run=run, idem="auth-" + uuid.uuid4().hex)
    check(status == 201, "Dataset de laboratorio sin sesión -> 201 (contrato S09 intacto)")

    idem = "auth-" + uuid.uuid4().hex
    status, order = request("POST", "/api/v1/orders", ORDER, token=tA, run=run, idem=idem)
    order_id = order.get("id", "")
    check(status == 201 and "customer" not in order, "Cliente A compra -> 201 y el JSON público del pedido no cambió")

    status, body = request("GET", f"/api/v1/orders/{order_id}/customer", token=tA, run=run)
    check(status == 200 and body.get("email") == emailA and body.get("full_name") == nameA,
          f"Pedido guarda al comprador: {nameA} · {emailA}")
    status, _ = request("GET", f"/api/v1/orders/{order_id}/customer", token=tB, run=run)
    check(status == 404, "Cliente B no ve el comprador del pedido de A -> 404")

    status, mine_a = request("GET", "/api/v1/me/orders", token=tA, run=run)
    status_b, mine_b = request("GET", "/api/v1/me/orders", token=tB, run=run)
    ids_a = [item["id"] for item in mine_a.get("items", [])]
    ids_b = [item["id"] for item in mine_b.get("items", [])]
    check(status == 200 and status_b == 200 and order_id in ids_a and order_id not in ids_b,
          "'Mis pedidos': A ve su pedido, B no")

    status, body = request("GET", "/api/v1/admin/orders", token=tA, run=run)
    check(status == 403 and code(body) == "FORBIDDEN", "Cliente en panel admin -> 403 FORBIDDEN")
    status, body = request("GET", "/api/v1/admin/orders", token=tAdmin, run=run)
    row = next((item for item in body.get("items", []) if item["id"] == order_id), None)
    check(status == 200 and row is not None and (row.get("customer") or {}).get("email") == emailA,
          "Admin ve todos los pedidos con su comprador")

    status, body = request("POST", "/api/v1/orders", ORDER, token=tB, run=run, idem=idem)
    check(status == 409 and code(body) == "IDEMPOTENCY_CONFLICT",
          "B reutiliza la Idempotency-Key de A -> 409 (no recibe el pedido de A)")
finally:
    request("DELETE", "/_lab/runs/" + run, lab=True)

status, _ = request("POST", "/api/v1/auth/logout", token=tA)
check(status == 204, "Cerrar sesión -> 204")

print(f"\nAuth: {len(counted) - len(failures)}/{len(counted)}.")
sys.exit(1 if failures else 0)
