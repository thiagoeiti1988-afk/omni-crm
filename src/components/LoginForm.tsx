"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

const DEMO_USERS = [
  { email: "owner@acme.demo", label: "Owner · Acme" },
  { email: "closer@acme.demo", label: "Closer · Acme" },
  { email: "copy@acme.demo", label: "Copy · Acme" },
  { email: "owner@beta.demo", label: "Owner · Beta" },
];

export default function LoginForm({ demo }: { demo: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? "Falha no login");
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("Sem conexão com o servidor");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 border border-zinc-800 rounded-2xl p-6 bg-zinc-900/60">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Omni-CRM</p>
          <h1 className="text-xl font-semibold mt-1">Entrar no console</h1>
          <p className="text-sm text-zinc-400 mt-1">Agentes trabalham, pessoas aprovam.</p>
        </div>
        <label className="block text-sm space-y-1">
          <span className="text-zinc-400">E-mail</span>
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2"
          />
        </label>
        <label className="block text-sm space-y-1">
          <span className="text-zinc-400">Senha</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2"
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-rose-400">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-sky-600 hover:bg-sky-500 disabled:opacity-60 rounded py-2 text-sm font-medium"
        >
          {busy ? "Entrando…" : "Entrar"}
        </button>
        {demo && (
          <div className="text-xs text-zinc-500 border-t border-zinc-800 pt-3 space-y-2">
            <p>Ambiente de demonstração — senha <code className="text-zinc-300">omni-demo-2026</code></p>
            <div className="flex flex-wrap gap-1">
              {DEMO_USERS.map((u) => (
                <button
                  key={u.email}
                  type="button"
                  onClick={() => {
                    setEmail(u.email);
                    setPassword("omni-demo-2026");
                  }}
                  className="border border-zinc-700 rounded px-2 py-1 hover:bg-zinc-800"
                >
                  {u.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </form>
    </main>
  );
}
