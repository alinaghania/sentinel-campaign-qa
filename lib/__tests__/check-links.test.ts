// Vérification des liens — comportement ANTI-BOT (voir en-tête de check-links.ts).
// fetch et le DNS sont mockés : ces tests ne sortent jamais sur le réseau.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkLinks } from "../check-links";
import type { EmailFacts, LinkCheckResult } from "../types";

vi.mock("dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

/** Réponses successives d'un scénario, dans l'ordre des hops. */
type Hop = { status: number; location?: string; contentType?: string; body?: string };

let calls: Array<{ url: string; method: string; headers: Record<string, string> }>;

function stubFetch(hops: Hop[]): void {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const headers = Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>)
      );
      calls.push({ url, method: init.method ?? "GET", headers });
      const hop = hops[Math.min(i++, hops.length - 1)];
      const h = new Headers();
      if (hop.location) h.set("location", hop.location);
      if (hop.contentType) h.set("content-type", hop.contentType);
      return new Response(hop.body ?? "", { status: hop.status, headers: h });
    })
  );
}

function facts(href: string, text = "CTA"): EmailFacts {
  return {
    links: [{ index: 0, href, text, kind: "statique", utm: {}, inMsoBlock: false }],
  } as unknown as EmailFacts;
}

const run = async (f: EmailFacts): Promise<LinkCheckResult> => (await checkLinks(f))[0];

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("empreinte navigateur (anti-bot)", () => {
  it("navigue en GET, jamais en HEAD (Akamai renvoie 403 sur un HEAD)", async () => {
    stubFetch([{ status: 200 }]);
    await run(facts("https://www.balenciaga.com/en-us"));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
  });

  it("envoie le jeu d'en-têtes complet d'un vrai Chrome, pas le seul User-Agent", async () => {
    stubFetch([{ status: 200 }]);
    await run(facts("https://www.balenciaga.com/en-us"));
    const h = calls[0].headers;
    // Un UA Chrome SANS ces en-têtes est la signature de bot qui déclenchait le 403.
    expect(h["sec-ch-ua"]).toContain("Chromium");
    expect(h["Sec-Fetch-Dest"]).toBe("document");
    expect(h["Sec-Fetch-Mode"]).toBe("navigate");
    expect(h["Accept-Language"]).toBeTruthy();
    expect(h["Upgrade-Insecure-Requests"]).toBe("1");
    // Cohérence UA ↔ sec-ch-ua : une version discordante est un signal de bot.
    const uaVersion = /Chrome\/(\d+)\./.exec(h["User-Agent"])?.[1];
    expect(h["sec-ch-ua"]).toContain(`"Chromium";v="${uaVersion}"`);
  });

  it("reste en cross-site sur toute la chaîne, comme un vrai navigateur", async () => {
    stubFetch([
      { status: 302, location: "https://www.balenciaga.com/en-us" }, // tracker → marque
      { status: 302, location: "https://www.balenciaga.com/de-de" }, // même origine
      { status: 200 },
    ]);
    await run(facts("https://click.news.balenciaga.com/?qs=abc"));
    // La navigation part d'un mail : la spec fetch ne fait que dégrader
    // Sec-Fetch-Site, jamais le remonter à "same-origin" en cours de chaîne.
    expect(calls.map((c) => c.headers["Sec-Fetch-Site"])).toEqual([
      "cross-site",
      "cross-site",
      "cross-site",
    ]);
  });
});

describe("classement des statuts refusés", () => {
  it.each([400, 403, 405, 429])(
    "HTTP %i = client refusé par le WAF → non_verifiable, jamais 'cassé'",
    async (status) => {
      stubFetch([{ status }]);
      const r = await run(facts("https://www.facebook.com/Balenciaga"));
      expect(r.status).toBe("non_verifiable");
      expect(r.httpStatus).toBe(status);
    }
  );

  it("404 et 5xx restent des liens réellement cassés", async () => {
    stubFetch([{ status: 404 }]);
    expect((await run(facts("https://www.balenciaga.com/nope"))).status).toBe("casse");
    stubFetch([{ status: 503 }]);
    expect((await run(facts("https://www.balenciaga.com/down"))).status).toBe("casse");
  });
});

describe("gardes de sécurité (inchangées)", () => {
  it("ne requête jamais un lien de désinscription", async () => {
    stubFetch([{ status: 200 }]);
    const r = await run(facts("https://cloud.news.balenciaga.com/unsubscribe?qs=abc", "Unsubscribe"));
    expect(r.status).toBe("non_teste");
    expect(calls).toHaveLength(0); // aucune requête émise
  });

  it("stoppe la chaîne si une redirection mène à une désinscription", async () => {
    stubFetch([
      { status: 302, location: "https://cloud.news.balenciaga.com/unsubscribe?qs=abc" },
      { status: 200 },
    ]);
    const r = await run(facts("https://click.news.balenciaga.com/?qs=abc"));
    expect(r.status).toBe("non_teste");
    expect(r.reason).toMatch(/unsubscribe/i);
    expect(calls).toHaveLength(1); // le hop unsub n'est PAS requêté
  });
});

describe("soft-404", () => {
  it("détecte un 200 dont le titre annonce une page introuvable", async () => {
    stubFetch([
      { status: 200, contentType: "text/html", body: "<html><title>Page not found</title>" },
    ]);
    const r = await run(facts("https://www.balenciaga.com/gone"));
    expect(r.status).toBe("suspect");
    expect(r.reason).toMatch(/soft-404/);
  });
});
