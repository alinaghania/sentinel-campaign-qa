// Proxy Next 16 (ex-middleware) — garde d'accès globale de Sentinel.
//
// Modèle : une clé d'accès unique (SENTINEL_ACCESS_KEY, Key Vault) ; le
// navigateur présente un cookie `sentinel_auth` contenant le SHA-256 hex de la
// clé (posé par POST /api/auth/login). Tout le reste est bloqué :
//   - /api/*  → 401 JSON
//   - pages   → 302 /login?next=<pathname>
// En production SANS clé configurée → 503 fail-closed sur tout (décision DA).
// En dev local sans clé → passthrough (pas de friction).
//
// ⚠️ /api/auth/google/callback reste PROTÉGÉ volontairement : le navigateur
// d'Alina possède déjà le cookie au retour de Google (décision DA).

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const COOKIE_NAME = "sentinel_auth";

// Cache du hash de la clé : la clé ne change pas pendant la vie du process.
let cachedKey: string | null = null;
let cachedHash: string | null = null;

/** SHA-256 hex via Web Crypto (disponible dans le runtime proxy). */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Comparaison en temps constant (le cookie contient le hash attendu). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function proxy(request: NextRequest) {
  const accessKey = process.env.SENTINEL_ACCESS_KEY;
  const isProd = process.env.NODE_ENV === "production";

  if (!accessKey) {
    // Dev local sans clé : accès libre.
    if (!isProd) return NextResponse.next();
    // Production sans clé : on refuse TOUT plutôt que d'exposer l'app.
    return Response.json(
      { error: "access key not configured" },
      { status: 503 }
    );
  }

  if (cachedKey !== accessKey || !cachedHash) {
    cachedHash = await sha256Hex(accessKey);
    cachedKey = accessKey;
  }

  const cookie = request.cookies.get(COOKIE_NAME)?.value;
  if (cookie && timingSafeEqualHex(cookie, cachedHash)) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api/")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl, 302);
}

export const config = {
  // Tout est protégé SAUF : la sonde de santé, la page/API de login, les
  // assets Next, le favicon et la mascotte publique (/letter/*, utilisée par
  // la page de login). /api/auth/google/callback n'est PAS exclu (cf. header).
  matcher: [
    "/((?!api/health|api/auth/login|login|_next/static|_next/image|favicon.ico|letter/).*)",
  ],
};
