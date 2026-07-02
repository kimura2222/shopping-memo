import { NextResponse } from "next/server";
import { getNotion, isConfigured } from "@/lib/notion";

export const dynamic = "force-dynamic";

const TEXT_BLOCKS = [
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "quote",
  "callout",
  "to_do",
];

// Notion ページ本文(詳細)から画像とテキストを取り出す。
// 画像の署名付き URL は失効するため、折り畳みを開いた都度取得する。
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!isConfigured) {
    return NextResponse.json({ images: [], texts: [] });
  }

  try {
    const notion = getNotion();
    const images: { url: string; caption: string }[] = [];
    const texts: string[] = [];
    let cursor: string | undefined = undefined;

    do {
      const r: any = await notion.blocks.children.list({
        block_id: id,
        start_cursor: cursor,
        page_size: 100,
      });
      for (const b of r.results as any[]) {
        if (b.type === "image") {
          const img = b.image;
          const url =
            img?.type === "external" ? img.external?.url : img?.file?.url;
          if (url) {
            const caption = (img.caption ?? [])
              .map((c: any) => c.plain_text ?? "")
              .join("");
            images.push({ url, caption });
          }
        } else if (TEXT_BLOCKS.includes(b.type)) {
          const rt = b[b.type]?.rich_text ?? [];
          const s = rt.map((x: any) => x.plain_text ?? "").join("");
          if (s.trim()) texts.push(s);
        }
      }
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);

    return NextResponse.json({ images, texts });
  } catch (err: any) {
    return NextResponse.json(
      { images: [], texts: [], error: err?.message ?? "詳細の取得に失敗しました" },
      { status: 500 }
    );
  }
}
