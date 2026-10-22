// パスコード認証(APP_PASSWORD)。一度ログインすると Cookie で長期間ログインを保つ。
// middleware(Edge)とAPI(Node)の両方から使うので、Web標準の crypto だけで書く。

export const AUTH_COOKIE = "sm_auth";
export const AUTH_MAX_AGE = 60 * 60 * 24 * 365; // 1年

// Cookie に入れる値。パスコードそのものではなくハッシュを入れる。
// パスコードを変えると値も変わるので、全端末が自動的にログアウトされる。
export async function authToken(password: string): Promise<string> {
  const data = new TextEncoder().encode(`shopping-memo:${password}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function isValidToken(token: string | undefined, password: string) {
  return !!token && token === (await authToken(password));
}
