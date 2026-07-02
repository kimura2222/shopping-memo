import { Client } from "@notionhq/client";

export const notionToken = process.env.NOTION_TOKEN;
export const rawDatabaseId = process.env.NOTION_DATABASE_ID;

// Notion のデータベースIDはハイフンあり/なしどちらの貼り方でも受け付ける
export function normalizeDatabaseId(id?: string): string | undefined {
  if (!id) return undefined;
  const clean = id.replace(/[^a-f0-9]/gi, "");
  if (clean.length !== 32) return id;
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(
    12,
    16
  )}-${clean.slice(16, 20)}-${clean.slice(20)}`;
}

export const databaseId = normalizeDatabaseId(rawDatabaseId);
export const isConfigured = Boolean(notionToken && databaseId);

let _client: Client | null = null;
export function getNotion(): Client {
  if (!_client) _client = new Client({ auth: notionToken });
  return _client;
}

export type FieldType = "select" | "multi_select" | "status";

export interface FieldOption {
  name: string;
  color: string;
}

/** グループ化・色分け・タグ変更の対象になる列(select / status / multi_select) */
export interface GroupField {
  name: string;
  type: FieldType;
  /** 単一値(select/status)は UI から値を変更できる */
  editable: boolean;
  options: FieldOption[];
}

/** 編集パネルで直接編集できる列の型 */
export type EditFieldType =
  | "title"
  | "rich_text"
  | "number"
  | "url"
  | "select"
  | "multi_select"
  | "status"
  | "date";

/** 編集可能な値。型ごとに: text系=string / number=number|null / multi_select=string[] */
export type EditValue = string | number | string[] | null;

export interface EditableField {
  name: string;
  type: EditFieldType;
  options?: FieldOption[]; // select / status / multi_select のみ
}

/** 正規化した買い物アイテム。UI はこの形だけを知っていればよい。 */
export interface ShoppingItem {
  id: string;
  title: string;
  done: boolean;
  price: number | null;
  /** URL 型の列(サンプル・Twitter 等)。詳細アコーディオン内に表示する */
  links: { label: string; url: string }[];
  note: string | null;
  /** 列名 → 選択中のオプション名(multi_select は複数) */
  values: Record<string, string[]>;
  /** 上記の役割に当てはまらない列(作者・サークル名など) */
  extra: { name: string; value: string }[];
  /** 編集用の生の値(列名 → 値)。編集パネルの初期値に使う。 */
  edit: Record<string, EditValue>;
}

export interface ItemsResponse {
  items: ShoppingItem[];
  demo: boolean;
  doneProp: string | null;
  priceProp: string | null;
  fields: GroupField[];
  defaultGroup: string | null;
  // 完了チェックと連動させる status 列の情報
  statusProp: string | null;
  statusCompleteValue: string | null; // 完了にするときに入れる値(例: 完了)
  statusCompleteValues: string[]; // Complete グループに属する全値
  statusTodoValue: string | null; // 未完了に戻すときの値(例: 未着手)
  // 編集パネル用
  editableFields: EditableField[];
  titleParts: string[]; // タイトルを構成する列(この順に連結)
  noteProp: string | null;
  urlProps: string[];
  error?: string;
}

// ---- 列名の候補(型で判定 + 名前で優先) ----
const DONE_NAMES = ["完了", "購入済", "購入済み", "済", "done", "checked", "bought", "get", "getした"];
const PRICE_NAMES = ["値段", "価格", "金額", "料金", "price", "cost"];
const NOTE_NAMES = ["メモ", "備考", "概要", "note", "notes", "memo", "comment"];
// タイトルに連結する列(この順に「 / 」で連結)。タイトル型の列を先頭に置く。
const TITLE_PART_NAMES = ["作者", "サークル名", "名前", "品名", "name", "author", "circle"];
const TITLE_SEPARATOR = " / ";
const GROUP_PREFERENCE = ["状態", "ステータス", "カテゴリ", "カテゴリー", "分類", "種類", "category", "status"];

function pickByName(
  entries: [string, any][],
  names: string[],
  type: string
): [string, any] | undefined {
  const lower = names.map((n) => n.toLowerCase());
  return entries.find(
    ([name, prop]) => prop.type === type && lower.includes(name.toLowerCase())
  );
}

function firstOfType(entries: [string, any][], type: string): [string, any] | undefined {
  return entries.find(([, prop]) => prop.type === type);
}

function richTextToPlain(rt: any[] | undefined): string {
  if (!rt) return "";
  return rt.map((t) => t.plain_text ?? "").join("");
}

function propToString(prop: any): string {
  switch (prop?.type) {
    case "title":
      return richTextToPlain(prop.title);
    case "rich_text":
      return richTextToPlain(prop.rich_text);
    case "number":
      return prop.number != null ? String(prop.number) : "";
    case "select":
      return prop.select?.name ?? "";
    case "multi_select":
      return (prop.multi_select ?? []).map((s: any) => s.name).join(", ");
    case "status":
      return prop.status?.name ?? "";
    case "checkbox":
      return prop.checkbox ? "✓" : "";
    case "url":
      return prop.url ?? "";
    case "email":
      return prop.email ?? "";
    case "phone_number":
      return prop.phone_number ?? "";
    case "formula":
      return prop.formula?.string ?? (prop.formula?.number != null ? String(prop.formula.number) : "");
    case "date":
      return prop.date?.start ?? "";
    case "people":
      return (prop.people ?? []).map((p: any) => p.name ?? "").join(", ");
    default:
      return "";
  }
}

function propToOptionNames(prop: any): string[] {
  switch (prop?.type) {
    case "select":
      return prop.select ? [prop.select.name] : [];
    case "status":
      return prop.status ? [prop.status.name] : [];
    case "multi_select":
      return (prop.multi_select ?? []).map((s: any) => s.name);
    default:
      return [];
  }
}

// 編集パネル用に、各列の生の値を編集しやすい形へ
function propToEditValue(prop: any, type: EditFieldType): EditValue {
  switch (type) {
    case "title":
      return richTextToPlain(prop?.title);
    case "rich_text":
      return richTextToPlain(prop?.rich_text);
    case "number":
      return prop?.number ?? null;
    case "url":
      return prop?.url ?? "";
    case "select":
      return prop?.select?.name ?? "";
    case "status":
      return prop?.status?.name ?? "";
    case "multi_select":
      return (prop?.multi_select ?? []).map((s: any) => s.name);
    case "date":
      return prop?.date?.start ?? "";
    default:
      return "";
  }
}

const EDITABLE_TYPES: EditFieldType[] = [
  "title",
  "rich_text",
  "number",
  "url",
  "select",
  "multi_select",
  "status",
  "date",
];

export interface Schema {
  titleName: string | null;
  /** タイトルに連結する追加列(タイトル型の後ろに順に連結) */
  titleExtra: string[];
  /** どれも空だったとき最後の頼みにする全 rich_text 列 */
  titleFallbacks: string[];
  doneName: string | null;
  priceName: string | null;
  urlNames: string[];
  noteName: string | null;
  fields: GroupField[];
  defaultGroup: string | null;
  statusProp: string | null;
  statusCompleteValue: string | null;
  statusCompleteValues: string[];
  statusTodoValue: string | null;
  editableFields: EditableField[];
}

/** databases.retrieve の properties から、各役割とグループ用フィールドを推定する。 */
export function buildSchema(properties: Record<string, any>): Schema {
  const entries = Object.entries(properties);

  const titleEntry = firstOfType(entries, "title");
  const doneEntry =
    pickByName(entries, DONE_NAMES, "checkbox") ?? firstOfType(entries, "checkbox");
  const priceEntry =
    pickByName(entries, PRICE_NAMES, "number") ?? firstOfType(entries, "number");
  const urlNames = entries.filter(([, p]) => p.type === "url").map(([n]) => n);
  const noteEntry = pickByName(entries, NOTE_NAMES, "rich_text");

  const richTexts = entries
    .filter(([, p]) => p.type === "rich_text")
    .map(([n]) => n)
    .filter((n) => n !== noteEntry?.[0]);

  // タイトルに連結する追加列(候補名の順、実在するものだけ)
  const titleExtra = TITLE_PART_NAMES.map((n) =>
    richTexts.find((r) => r.toLowerCase() === n.toLowerCase())
  ).filter((v, i, a): v is string => !!v && a.indexOf(v) === i);

  // どれも空のときの最終フォールバック(全 rich_text)
  const titleFallbacks = richTexts;

  // グループ/色分け/タグ変更に使える列
  const fields: GroupField[] = [];
  for (const [name, prop] of entries) {
    if (prop.type === "select" || prop.type === "status" || prop.type === "multi_select") {
      const rawOptions =
        prop.type === "select"
          ? prop.select?.options
          : prop.type === "status"
          ? prop.status?.options
          : prop.multi_select?.options;
      fields.push({
        name,
        type: prop.type,
        editable: prop.type === "select" || prop.type === "status",
        options: (rawOptions ?? []).map((o: any) => ({
          name: o.name,
          color: o.color ?? "default",
        })),
      });
    }
  }

  // デフォルトのグループ列: 状態/カテゴリ系を優先、無ければ最初の単一値フィールド
  let defaultGroup: string | null = null;
  for (const pref of GROUP_PREFERENCE) {
    const f = fields.find((x) => x.name.toLowerCase() === pref.toLowerCase());
    if (f) {
      defaultGroup = f.name;
      break;
    }
  }
  if (!defaultGroup) {
    defaultGroup =
      fields.find((f) => f.type === "status" || f.type === "select")?.name ??
      fields[0]?.name ??
      null;
  }

  // 編集パネルで直接編集できる列(Notionの列順のまま)
  const editableFields: EditableField[] = [];
  for (const [name, prop] of entries) {
    if (!EDITABLE_TYPES.includes(prop.type)) continue;
    const rawOptions =
      prop.type === "select"
        ? prop.select?.options
        : prop.type === "status"
        ? prop.status?.options
        : prop.type === "multi_select"
        ? prop.multi_select?.options
        : undefined;
    editableFields.push({
      name,
      type: prop.type,
      options: rawOptions
        ? rawOptions.map((o: any) => ({ name: o.name, color: o.color ?? "default" }))
        : undefined,
    });
  }

  // 完了チェックと連動させる status 列(Complete グループを持つもの)を特定
  let statusProp: string | null = null;
  let statusCompleteValue: string | null = null;
  let statusCompleteValues: string[] = [];
  let statusTodoValue: string | null = null;
  for (const [name, prop] of entries) {
    if (prop.type !== "status") continue;
    const groups: any[] = prop.status?.groups ?? [];
    const options: any[] = prop.status?.options ?? [];
    const byId: Record<string, string> = {};
    for (const o of options) byId[o.id] = o.name;
    const complete = groups.find((g) => /complete|完了|done/i.test(g.name));
    if (!complete) continue;
    const todo = groups.find((g) => /to-?do|未着手|未|todo/i.test(g.name));
    statusProp = name;
    statusCompleteValues = (complete.option_ids ?? []).map((i: string) => byId[i]).filter(Boolean);
    statusCompleteValue = statusCompleteValues[0] ?? null;
    statusTodoValue = todo
      ? (todo.option_ids ?? []).map((i: string) => byId[i]).filter(Boolean)[0] ?? null
      : options[0]?.name ?? null;
    break;
  }

  return {
    titleName: titleEntry?.[0] ?? null,
    titleExtra,
    titleFallbacks,
    doneName: doneEntry?.[0] ?? null,
    priceName: priceEntry?.[0] ?? null,
    urlNames,
    noteName: noteEntry?.[0] ?? null,
    fields,
    defaultGroup,
    statusProp,
    statusCompleteValue,
    statusCompleteValues,
    statusTodoValue,
    editableFields,
  };
}

export function normalizePage(page: any, schema: Schema): ShoppingItem {
  const props: Record<string, any> = page.properties ?? {};
  const fieldNames = new Set(schema.fields.map((f) => f.name));

  // タイトル = タイトル列 + 追加列(作者・サークル名…)を順に連結
  const partNames = [schema.titleName, ...schema.titleExtra].filter(Boolean) as string[];
  const parts: string[] = [];
  for (const name of partNames) {
    const v = propToString(props[name]);
    if (v) parts.push(v);
  }
  let title = parts.join(TITLE_SEPARATOR);

  let usedFallback: string | null = null;
  if (!title) {
    for (const fb of schema.titleFallbacks) {
      const v = propToString(props[fb]);
      if (v) {
        title = v;
        usedFallback = fb;
        break;
      }
    }
  }
  if (!title) title = "(名称未設定)";

  // タイトルを構成する列と、リンク列・その他役割の列は補足(extra)から除外
  const used = new Set(
    [
      ...partNames,
      ...schema.urlNames,
      schema.doneName,
      schema.priceName,
      schema.noteName,
      usedFallback,
    ].filter(Boolean) as string[]
  );

  const done = schema.doneName ? props[schema.doneName]?.checkbox === true : false;

  let price: number | null = null;
  if (schema.priceName) {
    const p = props[schema.priceName];
    if (p?.type === "number" && p.number != null) price = p.number;
  }

  const links: { label: string; url: string }[] = [];
  for (const name of schema.urlNames) {
    const u = propToString(props[name]);
    if (u) links.push({ label: name, url: u });
  }
  const note = schema.noteName ? propToString(props[schema.noteName]) || null : null;

  const values: Record<string, string[]> = {};
  for (const f of schema.fields) {
    values[f.name] = propToOptionNames(props[f.name]);
  }

  const extra: { name: string; value: string }[] = [];
  for (const [name, prop] of Object.entries(props)) {
    if (used.has(name) || fieldNames.has(name)) continue;
    const value = propToString(prop);
    if (value) extra.push({ name, value });
  }

  // 編集用の生の値(編集パネルの初期値)
  const edit: Record<string, EditValue> = {};
  for (const f of schema.editableFields) {
    edit[f.name] = propToEditValue(props[f.name], f.type);
  }

  return { id: page.id, title, done, price, links, note, values, extra, edit };
}
