import { NextResponse } from "next/server";
import {
  buildSchema,
  databaseId,
  databaseTitle,
  getNotion,
  hasToken,
  normalizeDatabaseId,
  normalizePage,
  type ItemsResponse,
} from "@/lib/notion";
import { demoFields, demoItems } from "@/lib/demo";

export const dynamic = "force-dynamic"; // 常に最新を取得

// 一覧取得。?db=<id or url> で対象データベースを指定(無ければ環境変数の既定)。
export async function GET(request: Request) {
  const dbParam = new URL(request.url).searchParams.get("db");
  const effectiveDb = (dbParam ? normalizeDatabaseId(dbParam) : null) || databaseId;

  if (!hasToken || !effectiveDb) {
    const res: ItemsResponse = {
      items: demoItems,
      demo: true,
      dbId: null,
      dbTitle: null,
      doneProp: null,
      priceProp: "値段",
      fields: demoFields,
      defaultGroup: "カテゴリ",
      statusProp: null,
      statusCompleteValue: null,
      statusCompleteValues: [],
      statusTodoValue: null,
      editableFields: [],
      titleParts: [],
      noteProp: "メモ",
      urlProps: [],
    };
    return NextResponse.json(res);
  }

  try {
    const notion = getNotion();

    // スキーマ(列の型・選択肢・色)と全行(ページネーション対応)は互いに独立なので同時に取得
    const queryAll = async () => {
      const pages: any[] = [];
      let cursor: string | undefined = undefined;
      do {
        const resp: any = await notion.databases.query({
          database_id: effectiveDb,
          start_cursor: cursor,
          page_size: 100,
        });
        pages.push(...resp.results);
        cursor = resp.has_more ? resp.next_cursor : undefined;
      } while (cursor);
      return pages;
    };
    const [db, pages]: [any, any[]] = await Promise.all([
      notion.databases.retrieve({ database_id: effectiveDb }),
      queryAll(),
    ]);
    const schema = buildSchema(db.properties);

    const items = pages.map((p) => normalizePage(p, schema));

    const res: ItemsResponse = {
      items,
      demo: false,
      dbId: effectiveDb,
      dbTitle: databaseTitle(db),
      doneProp: schema.doneName,
      priceProp: schema.priceName,
      fields: schema.fields,
      defaultGroup: schema.defaultGroup,
      statusProp: schema.statusProp,
      statusCompleteValue: schema.statusCompleteValue,
      statusCompleteValues: schema.statusCompleteValues,
      statusTodoValue: schema.statusTodoValue,
      editableFields: schema.editableFields,
      titleParts: [schema.titleName, ...schema.titleExtra].filter(Boolean) as string[],
      noteProp: schema.noteName,
      urlProps: schema.urlNames,
    };
    return NextResponse.json(res);
  } catch (err: any) {
    const res: ItemsResponse = {
      items: [],
      demo: false,
      dbId: effectiveDb,
      dbTitle: null,
      doneProp: null,
      priceProp: null,
      fields: [],
      defaultGroup: null,
      statusProp: null,
      statusCompleteValue: null,
      statusCompleteValues: [],
      statusTodoValue: null,
      editableFields: [],
      titleParts: [],
      noteProp: null,
      urlProps: [],
      error:
        (typeof err?.body === "string" ? err.body : null) ??
        err?.message ??
        "Notion からの取得に失敗しました。",
    };
    return NextResponse.json(res, { status: 500 });
  }
}

// Notion側の一時的な失敗(回数制限・混雑)。クライアントは更新を捨てずに後で送り直す。
const TRANSIENT_CODES = [
  "rate_limited",
  "conflict_error",
  "service_unavailable",
  "internal_server_error",
  "gateway_timeout",
  "notionhq_client_request_timeout",
];

// 更新: 1件のページの複数プロパティをまとめて更新(チェックと状態の連動・編集パネル)
export async function PATCH(request: Request) {
  const body = await request.json().catch(() => ({}));

  if (!hasToken) {
    // デモモードでは書き込まない(クライアント側で状態を保持)
    return NextResponse.json({ ok: true, demo: true });
  }

  try {
    const notion = getNotion();

    // 複数プロパティを1回でまとめて更新(チェックと状態の連動用)
    if (body.action === "update") {
      const { id, props } = body as {
        id: string;
        props: { name: string; type: string; value: any }[];
      };
      if (!id || !Array.isArray(props) || props.length === 0) {
        return NextResponse.json(
          { ok: false, error: "id / props が必要です" },
          { status: 400 }
        );
      }
      const rt = (s: any) =>
        s ? [{ text: { content: String(s) } }] : [];
      const properties: Record<string, any> = {};
      for (const p of props) {
        switch (p.type) {
          case "checkbox":
            properties[p.name] = { checkbox: !!p.value };
            break;
          case "status":
            properties[p.name] = p.value ? { status: { name: p.value } } : { status: null };
            break;
          case "select":
            properties[p.name] = p.value ? { select: { name: p.value } } : { select: null };
            break;
          case "title":
            properties[p.name] = { title: rt(p.value) };
            break;
          case "rich_text":
            properties[p.name] = { rich_text: rt(p.value) };
            break;
          case "number":
            properties[p.name] = {
              number: p.value === "" || p.value == null ? null : Number(p.value),
            };
            break;
          case "url":
            properties[p.name] = { url: p.value || null };
            break;
          case "multi_select":
            properties[p.name] = {
              multi_select: (Array.isArray(p.value) ? p.value : []).map((name: string) => ({
                name,
              })),
            };
            break;
          case "date":
            properties[p.name] = p.value ? { date: { start: p.value } } : { date: null };
            break;
        }
      }
      await notion.pages.update({ page_id: id, properties });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json(
      { ok: false, error: "不明な action です" },
      { status: 400 }
    );
  } catch (err: any) {
    const transient = TRANSIENT_CODES.includes(err?.code);
    return NextResponse.json(
      { ok: false, error: err?.message ?? "更新に失敗しました", retry: transient },
      { status: err?.code === "rate_limited" ? 429 : transient ? 503 : 500 }
    );
  }
}
