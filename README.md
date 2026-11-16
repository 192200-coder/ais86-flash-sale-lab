# Flash Sale Lab

Tienda demostrativa para AIS86. Semana9: comunicación y contratos. Catálogo, carrito y pedidos funcionan; la aceptación completa se comprueba con las pruebas del docente. Productos y precios ficticios, sin cobros ni datos personales. No es un sistema listo para producción.

## Arrancar

Instala Git y Docker Desktop con Compose; inicia Docker. Crea tu copia con **Use this template** y clónala. También puedes descargar Code → Download ZIP.

```powershell
git clone https://github.com/TU_USUARIO/TU_REPOSITORIO.git
cd TU_REPOSITORIO
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

En Linux/WSL/macOS: `bash start.sh`. La primera ejecución descarga imágenes y dependencias. Abre **http://localhost:8019**. Se generan claves distintas en `.env`; no lo subas a Git. Al detener los contenedores se conservan los datos.

## Comprobar arranque

```sh
docker compose exec api python /app/tools/smoke.py --target http://127.0.0.1:8000
```

El smoke comprueba la compra básica, no la aprobación de Semana9. Lee [el contrato de aceptación](contracts/semana09.md), [HTTP](contracts/openapi.json) y [eventos](contracts/order-created.schema.json).

## Compartir durante la evaluación

En PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\share.ps1
```

En cualquier terminal:

```sh
docker compose --profile share up -d tunnel
docker compose logs -f tunnel
```

Envía al docente la **URL HTTPS** que termina en `trycloudflare.com` y el valor `LAB_KEY` de tu `.env`, por canal privado. No compartas otras claves. El docente no necesita entrar a tu PC. No actives autenticación por email del túnel para el cliente automático.

Mientras el túnel está activo, cualquiera con la URL puede visitar la tienda demo; las operaciones de control de pruebas requieren la clave. No abras bases de datos, paneles Docker o servicios adicionales. El túnel es temporal, cambia su dirección y no garantiza disponibilidad.

Al terminar:

```sh
docker compose stop tunnel
```

## Semana 12: cuentas, compras y facturas

Login con **Supabase Auth**. El navegador solo habla con esta API, que hace de intermediaria hacia Supabase (patrón *Backend for Frontend*; la CSP `connect-src 'self'` se mantiene). Cada JWT se verifica en la API con la clave pública del proyecto (JWKS, ES256); el rol sale de `app_metadata.role`, que el usuario no puede modificar.

| Rol | Permisos |
| --- | --- |
| Sin sesión | Ver catálogo y consultar un pedido por su ID. **No puede comprar** en la tienda (401 `AUTH_REQUIRED`). |
| `cliente` | Comprar; **Mis compras** (`#mis-compras`) con el seguimiento de cada pedido y su **factura** (`#factura/<pedido>`), imprimible o guardable en PDF. Quien se registra en la tienda es siempre cliente. |
| `admin` | Además, **Administración** (`#admin`): resumen de ventas, todas las compras con su comprador, búsqueda por cliente, filtros por estado de factura y reintento de facturaciones fallidas. |

- **Comprador:** se guarda en `order_customers`, en la misma transacción que el pedido. El JSON público del pedido, el evento y la llamada al microservicio de facturación no cambian.
- **Factura:** S09 la compone con la factura oficial del microservicio (consultada en vivo: número, fecha de emisión, líneas, total) más el comprador, con desglose de IGV 18 % incluido en el precio. Es un comprobante interno de demostración, no válido ante SUNAT.
- **Seguimiento:** pedido confirmado → notificación enviada → factura emitida, cada paso con su fecha.
- **Pruebas del docente:** los datasets de laboratorio (`X-Lab-Key` + `X-Lab-Run`) conservan el contrato de S09 sin iniciar sesión.

Configuración en `.env` (valores del proyecto Supabase; la clave *publishable* es pública por diseño, la *secret* nunca va aquí):

```sh
SUPABASE_URL=https://TU_PROYECTO.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Dar rol de administrador a un usuario (SQL Editor de Supabase; el usuario debe cerrar e iniciar sesión para que su JWT lo incluya):

```sql
update auth.users set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}' where email = 'correo@ejemplo.com';
```

Comprobar (un admin y dos clientes de prueba, formato `correo | contraseña | rol` separados por `;`):

```powershell
$env:DEMO_USERS = "admin@... | ... | admin;ana@... | ... | cliente;bruno@... | ... | cliente"
docker compose exec -e DEMO_USERS api python /app/tools/check_auth.py --target http://127.0.0.1:8000
```

## Trabajar y detener

Modifica el backend sin cambiar las interfaces publicadas ni quitar seguridad. Para aplicar cambios: `docker compose up --build -d --wait`. Ver errores: `docker compose logs --tail 80 api worker`. Detener: `docker compose down` (no borra volúmenes).

El frontend está en `frontend/`; para desarrollarlo: `npm ci`, `npm run dev`, `npm run build` desde esa carpeta, con la API en8019. Backend en `backend/`. No subas `.env`, tokens, datos reales, dependencias instaladas ni reportes de evaluación.

Semanas10–15 evolucionarán sobre esta misma base; sus pruebas no son requisitos de Semana9.

[Cloudflare Quick Tunnels: condiciones y límites](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).
