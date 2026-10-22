import { NextResponse } from "next/server";
import { databaseTitle, getNotion, hasToken } from "@/lib/notion";

export const dynamic = "force-dynamic";

// インテグレーションに「接続」されているデータベースの一覧。
// 端末に保存せずここから取るので、PC・スマホで同じ一覧になる。
export async function GET() {
  if (!hasToken) return NextResponse.json({ databases: [] });

  try {
    const notion = getNotion();
    const databases: { id: string; title: string }[] = [];
    let cursor: string | undefined = undefined;
    do {
      const r: any = await notion.search({
        filter: { property: "object", value: "database" },
        start_cursor: cursor,
        page_size: 100,
      });
      for (const db of r.results as any[]) {
        if (db.archived || db.in_trash) continue;
        databases.push({ id: db.id, title: databaseTitle(db) });
      }
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);

    databases.sort((a, b) => a.title.localeCompare(b.title, "ja"));
    return NextResponse.json({ databases });
  } catch (err: any) {
    return NextResponse.json(
      { databases: [], error: err?.message ?? "一覧の取得に失敗しました" },
      { status: 500 }
    );
  }
}
