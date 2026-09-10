import { describe, expect, it } from "vitest";
import { diffSegments, IS_URL_RE, tokenizeUrl } from "../diff";

describe("diffSegments — mode URL (tokenisation par segments)", () => {
  it("IS_URL_RE : URLs pures oui, texte/URL avec espace non", () => {
    expect(IS_URL_RE.test("https://www.balenciaga.com/storelocator")).toBe(true);
    expect(IS_URL_RE.test("http://x.cn/a?b=1#c")).toBe(true);
    expect(IS_URL_RE.test("voir https://x.com")).toBe(false);
    expect(IS_URL_RE.test("")).toBe(false);
  });

  it("tokenizeUrl : host entier, segments de path avec leur /, params entiers, hash", () => {
    expect(
      tokenizeUrl("https://www.balenciaga.com/storelocator/mexico?utm_source=X&utm_campaign=Y#frag")
    ).toEqual([
      "https://www.balenciaga.com",
      "/storelocator",
      "/mexico",
      "?utm_source=X",
      "&utm_campaign=Y",
      "#frag",
    ]);
  });

  it("2 URLs différant d'un segment de path : host non-changed en UN token, seul le segment changé", () => {
    const { a, b } = diffSegments(
      "https://www.balenciaga.com/storelocator/mexico-guadalajara",
      "https://www.balenciaga.com/storelocator/mexico-cdmx"
    );
    // le host complet est un unique segment non-changed en tête
    expect(a[0]).toEqual({ text: "https://www.balenciaga.com/storelocator", changed: false });
    expect(a.filter((s) => s.changed).map((s) => s.text)).toEqual(["/mexico-guadalajara"]);
    expect(b.filter((s) => s.changed).map((s) => s.text)).toEqual(["/mexico-cdmx"]);
  });

  it("?utm_source=A vs =B : le paramètre ENTIER est marqué changé", () => {
    const { a, b } = diffSegments(
      "https://x.com/p?utm_source=CAMPAIGN_A&utm_medium=email",
      "https://x.com/p?utm_source=CAMPAIGN_B&utm_medium=email"
    );
    expect(a.filter((s) => s.changed).map((s) => s.text)).toEqual(["?utm_source=CAMPAIGN_A"]);
    expect(b.filter((s) => s.changed).map((s) => s.text)).toEqual(["?utm_source=CAMPAIGN_B"]);
  });

  it("non-URL : tokenizer texte classique (mots surlignés, pas des segments d'URL)", () => {
    const { a } = diffSegments("Bienvenido a Balenciaga", "Bienvenida a Balenciaga");
    expect(a.filter((s) => s.changed).map((s) => s.text)).toEqual(["Bienvenido"]);
    expect(a.some((s) => !s.changed && s.text.includes("Balenciaga"))).toBe(true);
  });

  it("diff contre \"\" ne crash pas (URL comme texte)", () => {
    const url = diffSegments("https://x.com/a?b=1", "");
    expect(url.a.every((s) => s.changed)).toBe(true);
    expect(url.b).toEqual([]);
    const txt = diffSegments("", "hello");
    expect(txt.a).toEqual([]);
    expect(txt.b).toEqual([{ text: "hello", changed: true }]);
  });
});
