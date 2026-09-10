"use client";

// Page de login minimaliste : un seul champ (access key) → POST
// /api/auth/login → cookie `sentinel_auth` → redirection vers ?next ?? "/".
// Style aligné sur le reste du repo (thème clair, cartes, mascotte Letter).

import { useState } from "react";
import Image from "next/image";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        // Cible de redirection : uniquement un chemin interne (anti open-redirect).
        const next = new URLSearchParams(window.location.search).get("next");
        const target =
          next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
        window.location.assign(target);
        return;
      }
      setError(
        res.status === 401
          ? "Invalid access key. Please try again."
          : "Login unavailable. Please try again later."
      );
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <div className="card pop-in w-full max-w-sm p-8">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Image
            src={error ? "/letter/error.png" : "/letter/hello.png"}
            alt="Sentinel mascot"
            width={72}
            height={72}
            className="float"
            priority
          />
          <div>
            <div className="doc-title text-[26px] uppercase tracking-[0.04em]">
              Sentinel
            </div>
            <p className="mt-1 text-[12px] text-dim">
              Restricted access — enter your access key to continue.
            </p>
          </div>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <input
            type="password"
            className="input"
            placeholder="Access key"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="current-password"
            disabled={busy}
          />
          {error && (
            <p className="text-[12px] font-semibold text-crit" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="btn btn-accent justify-center"
            disabled={busy || !password}
          >
            {busy ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    </div>
  );
}
