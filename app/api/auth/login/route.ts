// POST : échange le mot de passe (= SENTINEL_ACCESS_KEY) contre le cookie
// `sentinel_auth` (SHA-256 hex de la clé, celui attendu par proxy.ts).
// Comparaison timing-safe sur les digests + délai fixe de 300 ms (anti
// brute-force et anti-oracle de latence).
import { createHash, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE_NAME = "sentinel_auth";
const COOKIE_MAX_AGE = 2592000; // 30 jours
const FIXED_DELAY_MS = 300;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  // Délai fixe : la réponse part toujours ~300 ms après la réception.
  const waitFixedDelay = async () => {
    const remaining = FIXED_DELAY_MS - (Date.now() - started);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  };

  const accessKey = process.env.SENTINEL_ACCESS_KEY;
  if (!accessKey) {
    // Fail-closed : cette route est exclue du proxy, elle doit se protéger seule.
    await waitFixedDelay();
    return NextResponse.json(
      { error: "access key not configured" },
      { status: 503 }
    );
  }

  let password = "";
  try {
    const body: unknown = await req.json();
    if (
      typeof body === "object" &&
      body !== null &&
      typeof (body as { password?: unknown }).password === "string"
    ) {
      password = (body as { password: string }).password;
    }
  } catch {
    // Corps absent/invalide → mot de passe vide → 401 après le délai fixe.
  }

  // timingSafeEqual exige des buffers de même taille : on compare les SHA-256.
  const expected = sha256(accessKey);
  const provided = sha256(password);
  const ok = timingSafeEqual(expected, provided);

  await waitFixedDelay();

  if (!ok) {
    return NextResponse.json({ error: "invalid password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, expected.toString("hex"), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return res;
}
