import { NextResponse } from "next/server";
import { AUTH_COOKIE, AUTH_MAX_AGE, authToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

// パスコードを確認し、合っていればログイン用 Cookie を発行する
export async function POST(request: Request) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.json({ ok: true }); // 認証なし運用

  const body = await request.json().catch(() => ({}));
  if (typeof body?.passcode !== "string" || body.passcode !== password) {
    return NextResponse.json({ ok: false, error: "パスコードが違います" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, await authToken(password), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_MAX_AGE,
  });
  return res;
}
