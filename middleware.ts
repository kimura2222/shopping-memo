import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, isValidToken } from "@/lib/auth";

// APP_PASSWORD が設定されている場合のみパスコード認証をかける。
// ローカル開発では未設定にしておけば認証なしで使える。
export async function middleware(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();

  const { pathname, search } = req.nextUrl;
  if (pathname === "/login" || pathname === "/api/login") return NextResponse.next();

  if (await isValidToken(req.cookies.get(AUTH_COOKIE)?.value, password)) {
    return NextResponse.next();
  }

  // API は画面遷移させず 401 を返す(アプリ側でログイン画面へ移る)
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "ログインが必要です", auth: false }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // 静的アセット・PWA 関連は認証対象外(アイコン等が読めるように)
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest|sw.js|robots.txt).*)",
  ],
};
