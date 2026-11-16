"""Semana 12: verificación de JWT de Supabase y permisos (sin red ni base de datos)."""
import asyncio
import time
import uuid

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from pydantic import SecretStr, ValidationError

from app import auth, orders
from app.auth import SignupIn, optional_user, require_admin, verify_access_token
from app.config import Settings
from app.schemas import OrderCreate
from app.security import ApiError, DatasetContext

SUPABASE_URL = "https://demo-project.supabase.co"
ISSUER = SUPABASE_URL + "/auth/v1"
KID = "test-key-1"
PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())


def settings() -> Settings:
    return Settings(
        database_url="postgresql://user:pass@localhost:5432/flash",
        redis_url="redis://localhost:6379/0",
        lab_key=SecretStr("l" * 40),
        supabase_url=SUPABASE_URL,
        supabase_publishable_key=SecretStr("sb_publishable_test"),
    )


@pytest.fixture(autouse=True)
def trusted_jwks():
    auth.jwks_cache._keys = {KID: ("ES256", PRIVATE_KEY.public_key())}
    auth.jwks_cache._loaded_at = time.monotonic()
    auth.jwks_cache._last_forced = time.monotonic()  # sin recargas por red en las pruebas
    yield
    auth.jwks_cache._keys = {}
    auth.jwks_cache._loaded_at = 0.0


def make_token(key=PRIVATE_KEY, alg="ES256", kid=KID, **overrides) -> str:
    now = int(time.time())
    claims = {
        "sub": str(uuid.uuid4()),
        "email": "Ana@Example.com",
        "role": "authenticated",
        "aud": "authenticated",
        "iss": ISSUER,
        "iat": now,
        "exp": now + 3600,
        "user_metadata": {"full_name": "Ana Cliente"},
        "app_metadata": {"provider": "email"},
    }
    claims.update(overrides)
    return jwt.encode(claims, key, algorithm=alg, headers={"kid": kid})


def verify(token: str):
    return asyncio.run(verify_access_token(settings(), token))


def assert_invalid(token: str) -> None:
    with pytest.raises(ApiError) as caught:
        verify(token)
    assert caught.value.status_code == 401
    assert caught.value.code == "INVALID_TOKEN"


def test_valid_token_gives_client_with_data_from_jwt() -> None:
    user = verify(make_token())
    assert user.role == "cliente"
    assert user.email == "ana@example.com"
    assert user.full_name == "Ana Cliente"
    assert not user.is_admin


def test_admin_role_only_from_app_metadata() -> None:
    assert verify(make_token(app_metadata={"role": "admin"})).is_admin
    # user_metadata lo puede editar el propio usuario: no debe dar privilegios.
    assert not verify(make_token(user_metadata={"full_name": "X", "role": "admin"})).is_admin


def test_expired_token_rejected() -> None:
    past = int(time.time()) - 7200
    assert_invalid(make_token(iat=past, exp=past + 60))


def test_wrong_audience_and_issuer_rejected() -> None:
    assert_invalid(make_token(aud="anon"))
    assert_invalid(make_token(iss="https://otro-proyecto.supabase.co/auth/v1"))


def test_anon_role_rejected() -> None:
    assert_invalid(make_token(role="anon"))


def test_token_signed_by_other_key_rejected() -> None:
    assert_invalid(make_token(key=ec.generate_private_key(ec.SECP256R1())))


def test_tampered_payload_rejected() -> None:
    header, _, signature = make_token().split(".")
    forged = make_token(key=ec.generate_private_key(ec.SECP256R1()), app_metadata={"role": "admin"})
    assert_invalid(".".join([header, forged.split(".")[1], signature]))


def test_symmetric_and_none_algorithms_rejected() -> None:
    assert_invalid(make_token(key="secreto-compartido-de-32-bytes!!", alg="HS256"))
    assert_invalid(make_token(key=None, alg="none"))


def test_unknown_key_id_rejected() -> None:
    assert_invalid(make_token(kid="otra-clave"))


def test_bearer_scheme_required() -> None:
    with pytest.raises(ApiError) as caught:
        asyncio.run(optional_user(request=FakeRequest(), authorization="Basic abc"))
    assert caught.value.status_code == 401
    assert asyncio.run(optional_user(request=FakeRequest(), authorization=None)) is None


def test_client_cannot_use_admin_routes() -> None:
    client = verify(make_token())
    with pytest.raises(ApiError) as caught:
        asyncio.run(require_admin(user=client))
    assert caught.value.status_code == 403


def test_signup_cannot_choose_role() -> None:
    with pytest.raises(ValidationError):
        SignupIn(full_name="Eve", email="eve@example.com", password="12345678", role="admin")
    with pytest.raises(ValidationError):
        SignupIn(full_name="Eve", email="no-es-correo", password="12345678")
    assert SignupIn(full_name="  Eve   Doe ", email="EVE@example.com", password="12345678").email == "eve@example.com"


class FakeRequest:
    class app:  # noqa: N801
        class state:  # noqa: N801
            settings = settings()


def test_public_store_order_requires_sign_in() -> None:
    payload = OrderCreate(items=[{"product_id": "arc-mouse", "quantity": 1}])
    public = DatasetContext(dataset_id="public", notification_delay_ms=0, run_id=None)
    with pytest.raises(ApiError) as caught:
        asyncio.run(orders.create_order(payload, FakeRequest(), None, public, "idem-12345678", None))
    assert caught.value.status_code == 401
    assert caught.value.code == "AUTH_REQUIRED"


def test_lab_dataset_keeps_s09_contract_without_sign_in(monkeypatch) -> None:
    captured = {}

    async def fake_create(session, dataset_id, key, request_hash, payload, user):
        captured["user"] = user
        return {"id": str(uuid.uuid4())}

    monkeypatch.setattr(orders, "_create_or_replay", fake_create)
    payload = OrderCreate(items=[{"product_id": "arc-mouse", "quantity": 1}])
    lab = DatasetContext(dataset_id=str(uuid.uuid4()), notification_delay_ms=0, run_id=uuid.uuid4())
    response = asyncio.run(orders.create_order(payload, FakeRequest(), None, lab, "idem-12345678", None))
    assert response.status_code == 201
    assert captured["user"] is None
