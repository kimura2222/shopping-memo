import type { GroupField, ShoppingItem } from "./notion";

// トークン未設定でもUIを確認できるようにするサンプルデータ
export const demoFields: GroupField[] = [
  {
    name: "カテゴリ",
    type: "select",
    editable: true,
    options: [
      { name: "野菜", color: "green" },
      { name: "乳製品", color: "blue" },
      { name: "肉・魚", color: "red" },
      { name: "パン・主食", color: "orange" },
      { name: "日用品", color: "yellow" },
      { name: "その他", color: "gray" },
    ],
  },
  {
    name: "優先度",
    type: "multi_select",
    editable: false,
    options: [
      { name: "高", color: "red" },
      { name: "中", color: "yellow" },
      { name: "低", color: "gray" },
    ],
  },
];

function it(
  id: string,
  title: string,
  cat: string,
  price: number | null,
  pri: string,
  done = false,
  note: string | null = null,
  extra: { name: string; value: string }[] = []
): ShoppingItem {
  return {
    id,
    title,
    done,
    price,
    links: [],
    note,
    values: { カテゴリ: [cat], 優先度: [pri] },
    extra,
    edit: {},
    flagged: false,
  };
}

export const demoItems: ShoppingItem[] = [
  it("d1", "牛乳", "乳製品", 230, "中", false, "低脂肪"),
  it("d2", "卵", "乳製品", 280, "高"),
  it("d3", "トマト", "野菜", 150, "低"),
  it("d4", "玉ねぎ", "野菜", 120, "中", true),
  it("d5", "鶏むね肉", "肉・魚", 480, "高", false, "特売なら多めに"),
  it("d6", "サーモン", "肉・魚", 600, "中"),
  it("d7", "食パン", "パン・主食", 200, "低", true),
  it("d8", "米", "パン・主食", 1800, "高"),
  it("d9", "洗剤", "日用品", 350, "低", false, "詰め替え用"),
  it("d10", "ティッシュ", "日用品", 400, "中"),
  it("d11", "コーヒー豆", "その他", 900, "中"),
];
