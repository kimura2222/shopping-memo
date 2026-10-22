"use client";

import { useState } from "react";

// パスコード入力画面。成功すると Cookie が発行され、元のページへ戻る。
export default function LoginPage() {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!passcode || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setError(data.error ?? "ログインに失敗しました");
        return;
      }
      // 戻り先はサイト内のパスだけ許可(外部サイトへ飛ばされないように)
      const next = new URLSearchParams(location.search).get("next") ?? "/";
      location.replace(next.startsWith("/") && !next.startsWith("//") ? next : "/");
    } catch {
      setError("通信に失敗しました。電波を確認してください。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container login">
      <h1 className="title">🛒 買い物リスト</h1>
      <form className="login-form" onSubmit={submit}>
        <label className="login-label" htmlFor="passcode">
          パスコード
        </label>
        <input
          id="passcode"
          className="search"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
        />
        <button className="btn primary" type="submit" disabled={busy || !passcode}>
          {busy ? "確認中…" : "ログイン"}
        </button>
        {error && <div className="login-error">{error}</div>}
        <p className="login-hint">一度ログインすると、この端末では1年間そのまま使えます。</p>
      </form>
    </div>
  );
}
