import { NextResponse } from "next/server";
import {
  databaseTitle,
  extractDatabaseIdFromUrl,
  getNotion,
  hasToken,
} from "@/lib/notion";

export const dynamic = "force-dynamic";

// NotionのURLからデータベースを検証し、id と title を返す(登録用)。
export async function POST(request: Request) {
  if (!hasToken) {
    return NextResponse.json(
      { error: "サーバーにNotionトークンが設定されていません。" },
      { status: 400 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const id = extractDatabaseIdFromUrl(body?.url ?? "");
  if (!id) {
    return NextResponse.json(
      { error: "URLからデータベースIDを取得できませんでした。データベースのURLを貼ってください。" },
      { status: 400 }
    );
  }

  try {
    const notion = getNotion();
    const db: any = await notion.databases.retrieve({ database_id: id });
    return NextResponse.json({ id, title: databaseTitle(db) });
  } catch (err: any) {
    const raw =
      (typeof err?.body === "string" ? err.body : null) ?? err?.message ?? "";
    let message = "データベースを取得できませんでした。";
    if (/linked database/i.test(raw)) {
      message =
        "これはリンクドDB(ビュー)です。元のデータベースのURLを使ってください。";
    } else if (/Could not find database|object_not_found/i.test(raw)) {
      message =
        "見つかりませんでした。そのデータベースをインテグレーションに『接続』し、IDが正しいか確認してください。";
    } else if (raw) {
      message = raw;
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
