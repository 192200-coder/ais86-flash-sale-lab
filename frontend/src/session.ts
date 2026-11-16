/**
 * Semana 12: sesión del usuario (Supabase Auth a través de la API de S09).
 *
 * Guarda access_token (JWT, 1 h) y refresh_token en localStorage y renueva el JWT
 * automáticamente cuando le queda menos de 1 minuto. Las peticiones que lo necesitan
 * lo envían como `Authorization: Bearer`; el rol (cliente/admin) lo decide el servidor
 * a partir del JWT verificado: lo que diga este archivo solo sirve para mostrar la interfaz.
 */
import { ApiError, loginRequest, logoutRequest, refreshRequest, setTokenProvider, signupRequest } from './api';
import type { Session } from './types';

const sessionKey = 'flash-sale:session:v1';
const refreshMarginMs = 60_000;

type Listener = (session: Session | null) => void;

let current: Session | null = readStored();
let refreshing: Promise<Session | null> | null = null;
const listeners = new Set<Listener>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStored(): Session | null {
  try {
    const raw = window.localStorage.getItem(sessionKey);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (
      isRecord(parsed) &&
      typeof parsed.accessToken === 'string' &&
      typeof parsed.refreshToken === 'string' &&
      typeof parsed.expiresAt === 'number' &&
      isRecord(parsed.user) &&
      typeof parsed.user.id === 'string' &&
      typeof parsed.user.email === 'string' &&
      typeof parsed.user.full_name === 'string'
    ) {
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt,
        user: {
          id: parsed.user.id,
          email: parsed.user.email,
          full_name: parsed.user.full_name,
          role: parsed.user.role === 'admin' ? 'admin' : 'cliente'
        }
      };
    }
  } catch {
    return null;
  }
  return null;
}

function save(session: Session | null): void {
  current = session;
  try {
    if (session) {
      window.localStorage.setItem(sessionKey, JSON.stringify(session));
    } else {
      window.localStorage.removeItem(sessionKey);
    }
  } catch {
    // Sin almacenamiento la sesión dura lo que dure la pestaña.
  }
  for (const listener of listeners) {
    listener(session);
  }
}

export function currentSession(): Session | null {
  return current;
}

export function onSessionChange(listener: Listener): void {
  listeners.add(listener);
}

export async function signIn(email: string, password: string): Promise<Session> {
  const session = await loginRequest(email, password);
  save(session);
  return session;
}

/** `null` = la cuenta se creó pero Supabase exige confirmar el correo. */
export async function signUp(fullName: string, email: string, password: string): Promise<Session | null> {
  const session = await signupRequest(fullName, email, password);
  if (session) {
    save(session);
  }
  return session;
}

export async function signOut(): Promise<void> {
  const session = current;
  save(null);
  if (session && session.expiresAt > Date.now()) {
    try {
      await logoutRequest(session.accessToken);
    } catch {
      // La sesión local ya se borró; si el servidor no responde, el JWT expira solo.
    }
  }
}

/** Sesión inválida en el servidor (401): se descarta la local. */
export function expireSession(): void {
  if (current) {
    save(null);
  }
}

async function validAccessToken(): Promise<string | null> {
  const session = current;
  if (!session) {
    return null;
  }
  if (session.expiresAt - Date.now() > refreshMarginMs) {
    return session.accessToken;
  }
  if (!refreshing) {
    refreshing = refreshRequest(session.refreshToken)
      .then((next) => {
        save(next);
        return next;
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          save(null);
          return null;
        }
        // Error de red: se sigue usando el JWT actual mientras no haya expirado.
        return current && current.expiresAt > Date.now() ? current : null;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  const next = await refreshing;
  return next?.accessToken ?? null;
}

setTokenProvider(validAccessToken);
