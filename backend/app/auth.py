"""Autenticación con Supabase Auth (Semana 12).

Flujo (patrón Backend for Frontend):
  navegador --(correo y contraseña)--> S09 /api/v1/auth/* --> Supabase Auth
  navegador <--(access_token JWT + refresh_token)-- S09
  navegador --(Authorization: Bearer <JWT>)--> S09 (compras, mis pedidos, panel admin)

El navegador solo habla con S09 (la CSP `connect-src 'self'` se mantiene). S09 verifica
cada JWT localmente con la clave PÚBLICA del proyecto (JWKS, firma ES256): no guarda ningún
secreto de Supabase y no consulta a Supabase en cada petición.

Roles: `app_metadata.role` del JWT. Solo un administrador puede cambiarlo (el usuario no
puede editar app_metadata). "admin" -> admin; cualquier otro valor o ausencia -> cliente.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from dataclasses import dataclass
from typing import Any

import httpx
import jwt
from fastapi import APIRouter, Depends, Header, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .config import Settings
from .security import ApiError, get_settings_from_request

logger = logging.getLogger(__name__)

ROLE_ADMIN = "admin"
ROLE_CLIENT = "cliente"
ALLOWED_ALGORITHMS = {"ES256", "RS256", "EdDSA"}  # solo asimétricos: nunca HS256 ni "none"
EMAIL_PATTERN = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,189}\.[A-Za-z]{2,24}$")
USER_AGENT = "ais86-flash-sale/1.0"


@dataclass(frozen=True)
class CurrentUser:
    id: uuid.UUID
    email: str
    full_name: str
    role: str

    @property
    def is_admin(self) -> bool:
        return self.role == ROLE_ADMIN


def user_view(user: CurrentUser) -> dict[str, Any]:
    return {"id": str(user.id), "email": user.email, "full_name": user.full_name, "role": user.role}


# --- Verificación de JWT -------------------------------------------------------------------

class JwksCache:
    """Claves públicas del proyecto, cacheadas. Un `kid` desconocido fuerza una recarga
    (rotación de claves), como mucho una vez cada 30 s para no amplificar ataques."""

    def __init__(self) -> None:
        self._keys: dict[str, tuple[str, Any]] = {}
        self._loaded_at = 0.0
        self._last_forced = 0.0
        self._lock = asyncio.Lock()

    async def _load(self, settings: Settings) -> None:
        url = settings.auth_issuer() + "/.well-known/jwks.json"
        async with httpx.AsyncClient(timeout=settings.auth_timeout_seconds, headers={"User-Agent": USER_AGENT}) as client:
            response = await client.get(url)
        response.raise_for_status()
        keys: dict[str, tuple[str, Any]] = {}
        for entry in response.json().get("keys", []):
            kid, alg = entry.get("kid"), entry.get("alg")
            if isinstance(kid, str) and alg in ALLOWED_ALGORITHMS:
                keys[kid] = (alg, jwt.PyJWK(entry).key)
        self._keys = keys
        self._loaded_at = time.monotonic()

    async def get(self, settings: Settings, kid: str) -> tuple[str, Any] | None:
        async with self._lock:
            now = time.monotonic()
            expired = now - self._loaded_at > settings.auth_jwks_ttl_seconds
            unknown = kid not in self._keys and now - self._last_forced > 30
            if expired or unknown:
                if unknown:
                    self._last_forced = now
                try:
                    await self._load(settings)
                except Exception as exc:
                    logger.warning("jwks load failed type=%s", type(exc).__name__)
                    if not self._keys:
                        raise ApiError(503, "AUTH_UNAVAILABLE", "Authentication service unavailable") from None
            return self._keys.get(kid)


jwks_cache = JwksCache()


def _invalid_token() -> ApiError:
    return ApiError(401, "INVALID_TOKEN", "Invalid or expired session", headers={"WWW-Authenticate": "Bearer"})


def user_from_claims(claims: dict[str, Any]) -> CurrentUser:
    try:
        user_id = uuid.UUID(str(claims["sub"]))
    except (KeyError, ValueError):
        raise _invalid_token() from None
    if claims.get("role") != "authenticated":
        raise _invalid_token()
    email = str(claims.get("email") or "").strip().lower()[:254]
    metadata = claims.get("user_metadata") if isinstance(claims.get("user_metadata"), dict) else {}
    app_metadata = claims.get("app_metadata") if isinstance(claims.get("app_metadata"), dict) else {}
    full_name = str(metadata.get("full_name") or "").strip()[:80] or email.split("@")[0] or "Cliente"
    role = ROLE_ADMIN if app_metadata.get("role") == ROLE_ADMIN else ROLE_CLIENT
    return CurrentUser(id=user_id, email=email, full_name=full_name, role=role)


async def verify_access_token(settings: Settings, token: str) -> CurrentUser:
    if not settings.auth_configured():
        raise ApiError(503, "AUTH_NOT_CONFIGURED", "Authentication is not configured")
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError:
        raise _invalid_token() from None
    kid, alg = header.get("kid"), header.get("alg")
    if not isinstance(kid, str) or alg not in ALLOWED_ALGORITHMS:
        raise _invalid_token()
    found = await jwks_cache.get(settings, kid)
    if found is None or found[0] != alg:
        raise _invalid_token()
    try:
        claims = jwt.decode(
            token,
            found[1],
            algorithms=[found[0]],
            audience="authenticated",
            issuer=settings.auth_issuer(),
            leeway=30,
            options={"require": ["exp", "iat", "sub", "aud", "iss"]},
        )
    except jwt.PyJWTError:
        raise _invalid_token() from None
    return user_from_claims(claims)


def _bearer(authorization: str | None) -> str | None:
    if authorization is None:
        return None
    scheme, _, token = authorization.partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token or len(token) > 4096:
        raise _invalid_token()
    return token


async def optional_user(
    request: Request,
    authorization: str | None = Header(default=None),
) -> CurrentUser | None:
    """Sin cabecera -> None (anónimo). Cabecera presente pero inválida -> 401."""
    token = _bearer(authorization)
    if token is None:
        return None
    return await verify_access_token(get_settings_from_request(request), token)


async def require_user(user: CurrentUser | None = Depends(optional_user)) -> CurrentUser:
    if user is None:
        raise ApiError(401, "AUTH_REQUIRED", "Sign in required", headers={"WWW-Authenticate": "Bearer"})
    return user


async def require_admin(user: CurrentUser = Depends(require_user)) -> CurrentUser:
    if not user.is_admin:
        raise ApiError(403, "FORBIDDEN", "Administrator role required")
    return user


# --- Login, registro y sesión (proxy hacia Supabase Auth) ----------------------------------

def _clean_email(value: str) -> str:
    value = value.strip().lower()
    if not EMAIL_PATTERN.fullmatch(value):
        raise ValueError("invalid email")
    return value


class LoginIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(max_length=254)
    password: str = Field(min_length=1, max_length=72)

    @field_validator("email")
    @classmethod
    def clean_email(cls, value: str) -> str:
        return _clean_email(value)


class SignupIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    full_name: str = Field(min_length=2, max_length=80)
    email: str = Field(max_length=254)
    password: str = Field(min_length=8, max_length=72)

    @field_validator("email")
    @classmethod
    def clean_email(cls, value: str) -> str:
        return _clean_email(value)

    @field_validator("full_name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if len(value) < 2 or any(ord(char) < 32 for char in value):
            raise ValueError("invalid name")
        return value


class RefreshIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    refresh_token: str = Field(min_length=1, max_length=512)


_AUTH_ERRORS: dict[str, tuple[int, str, str]] = {
    "invalid_credentials": (401, "INVALID_CREDENTIALS", "Invalid email or password"),
    "email_not_confirmed": (403, "EMAIL_NOT_CONFIRMED", "Email not confirmed"),
    "user_already_exists": (409, "USER_EXISTS", "User already registered"),
    "email_exists": (409, "USER_EXISTS", "User already registered"),
    "weak_password": (422, "WEAK_PASSWORD", "Password is too weak"),
    "email_address_invalid": (422, "VALIDATION_ERROR", "Invalid email address"),
    "validation_failed": (422, "VALIDATION_ERROR", "Invalid sign-up data"),
    "signup_disabled": (403, "SIGNUP_DISABLED", "Sign-up is disabled"),
    "email_provider_disabled": (403, "SIGNUP_DISABLED", "Sign-up is disabled"),
    "refresh_token_not_found": (401, "SESSION_EXPIRED", "Session expired"),
    "refresh_token_already_used": (401, "SESSION_EXPIRED", "Session expired"),
    "session_not_found": (401, "SESSION_EXPIRED", "Session expired"),
    "session_expired": (401, "SESSION_EXPIRED", "Session expired"),
}


async def _supabase_auth(
    settings: Settings,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    bearer: str | None = None,
) -> tuple[int, dict[str, Any]]:
    if not settings.auth_configured():
        raise ApiError(503, "AUTH_NOT_CONFIGURED", "Authentication is not configured")
    headers = {"apikey": settings.supabase_key_value(), "User-Agent": USER_AGENT}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    try:
        async with httpx.AsyncClient(timeout=settings.auth_timeout_seconds) as client:
            response = await client.request(method, settings.auth_issuer() + path, json=body, headers=headers)
    except httpx.HTTPError:
        raise ApiError(503, "AUTH_UNAVAILABLE", "Authentication service unavailable") from None
    try:
        payload = response.json() if response.content else {}
    except ValueError:
        payload = {}
    if response.status_code < 400:
        return response.status_code, payload if isinstance(payload, dict) else {}
    code = str(payload.get("error_code") or payload.get("code") or payload.get("error") or "") if isinstance(payload, dict) else ""
    if code in _AUTH_ERRORS:
        status, api_code, message = _AUTH_ERRORS[code]
        raise ApiError(status, api_code, message)
    if response.status_code == 429 or code.startswith("over_"):
        raise ApiError(429, "RATE_LIMITED", "Too many authentication attempts", headers={"Retry-After": "60"})
    if code == "invalid_grant" or response.status_code in (400, 401):
        raise ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password")
    logger.warning("supabase auth error status=%s code=%s", response.status_code, code[:40])
    raise ApiError(503, "AUTH_UNAVAILABLE", "Authentication service unavailable")


async def _session_view(settings: Settings, payload: dict[str, Any]) -> dict[str, Any]:
    access_token = payload.get("access_token")
    refresh_token = payload.get("refresh_token")
    if not isinstance(access_token, str) or not isinstance(refresh_token, str):
        raise ApiError(503, "AUTH_UNAVAILABLE", "Authentication service returned no session")
    # El rol y los datos que devolvemos salen del JWT verificado, no de la respuesta sin firmar.
    user = await verify_access_token(settings, access_token)
    expires_in = payload.get("expires_in")
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_in": expires_in if isinstance(expires_in, int) and expires_in > 0 else 3600,
        "user": user_view(user),
    }


router = APIRouter(prefix="/api/v1/auth")


@router.post("/login")
async def login(payload: LoginIn, request: Request) -> dict[str, Any]:
    settings = get_settings_from_request(request)
    _, data = await _supabase_auth(
        settings, "POST", "/token?grant_type=password", {"email": payload.email, "password": payload.password}
    )
    return await _session_view(settings, data)


@router.post("/signup")
async def signup(payload: SignupIn, request: Request, response: Response) -> dict[str, Any]:
    settings = get_settings_from_request(request)
    # Solo se envía full_name (user_metadata). El rol vive en app_metadata, que el registro
    # no puede tocar: todo usuario nuevo es "cliente".
    _, data = await _supabase_auth(
        settings,
        "POST",
        "/signup",
        {"email": payload.email, "password": payload.password, "data": {"full_name": payload.full_name}},
    )
    if isinstance(data.get("access_token"), str):
        response.status_code = 201
        return await _session_view(settings, data)
    # "Confirm email" activo en Supabase: no hay sesión hasta confirmar el correo.
    response.status_code = 202
    return {"confirmation_required": True}


@router.post("/refresh")
async def refresh(payload: RefreshIn, request: Request) -> dict[str, Any]:
    settings = get_settings_from_request(request)
    _, data = await _supabase_auth(
        settings, "POST", "/token?grant_type=refresh_token", {"refresh_token": payload.refresh_token}
    )
    return await _session_view(settings, data)


@router.post("/logout", status_code=204)
async def logout(
    request: Request,
    user: CurrentUser = Depends(require_user),
    authorization: str | None = Header(default=None),
) -> Response:
    settings = get_settings_from_request(request)
    try:
        await _supabase_auth(settings, "POST", "/logout?scope=local", bearer=_bearer(authorization))
    except ApiError as exc:
        if exc.code not in ("SESSION_EXPIRED", "INVALID_CREDENTIALS"):
            raise
    return Response(status_code=204)


@router.get("/me")
async def me(user: CurrentUser = Depends(require_user)) -> dict[str, Any]:
    return user_view(user)
