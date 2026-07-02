import { NextRequest, NextResponse } from "next/server";

// APP_PASSWORD が設定されている場合のみ Basic 認証をかける。
// ローカル開発では未設定にしておけば認証なしで使える。
export function middleware(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();

  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const pass = decoded.slice(decoded.indexOf(":") + 1);
      if (pass === password) return NextResponse.next();
    } catch {
      // fallthrough
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Shopping List"' },
  });
}

export const config = {
  // 静的アセット・PWA 関連は認証対象外(アイコン等が読めるように)
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest|sw.js|robots.txt).*)",
  ],
};
