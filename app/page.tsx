"use client";

import { useEffect, useMemo, useState } from "react";
import type { GroupField, ItemsResponse, ShoppingItem } from "@/lib/notion";
import { colorFor } from "@/lib/colors";
import {
  enqueue,
  loadCache,
  loadQueue,
  saveCache,
  saveQueue,
  type CachedData,
  type QueueOp,
} from "@/lib/offline";

const NO_GROUP = "__none__";
const UNSET = "(未設定)";

// 背景色の条件付き表示に使う列/値
const PRIORITY_FIELD = "優先度";
const PRIORITY_HIGH = "高";

interface Detail {
  loading: boolean;
  images: { url: string; caption: string }[];
  texts: string[];
  error?: string;
}

// 50音の並び順。清音(あ〜ん)を先に、濁音・半濁音はその後ろにまとめる。
const KANA_ORDER =
  "ぁあぃいぅうぇえぉお" +
  "かきくけこ" +
  "さしすせそ" +
  "たちっつてと" +
  "なにぬねの" +
  "はひふへほ" +
  "まみむめも" +
  "ゃやゅゆょよ" +
  "らりるれろ" +
  "ゎわゐゑをん" +
  "ー" +
  // ↓ ここから濁音・半濁音(あ〜んの次)
  "がぎぐげご" +
  "ざじずぜぞ" +
  "だぢづでど" +
  "ばびぶべぼ" +
  "ぱぴぷぺぽ" +
  "ゔ";

const KANA_RANK: Record<string, number> = Object.fromEntries(
  [...KANA_ORDER].map((c, i) => [c, i])
);

// 並び順の階層: ひらがな(清音→濁音半濁音) < 漢字・英数記号 < カタカナ(最後尾)
const NONKANA_BASE = KANA_ORDER.length; // ひらがなの後ろ
const KATAKANA_BASE = 0x200000; // どの文字コードよりも大きく → 常に最後

function rankOf(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  // カタカナ(反復記号ヽヾ含む)は最後尾へ。内部はひらがな相当の50音順で並べる。
  if ((c >= 0x30a1 && c <= 0x30fa) || c === 0x30fd || c === 0x30fe) {
    const hira = String.fromCodePoint(c - 0x60);
    const sub = KANA_RANK[hira] ?? c - 0x30a1;
    return KATAKANA_BASE + sub;
  }
  const r = KANA_RANK[ch];
  if (r != null) return r; // ひらがな(清音・濁音・半濁音)
  return NONKANA_BASE + c; // 漢字・英数・記号(ひらがなの後、カタカナの前)
}

// 50音(濁音は後ろ)でタイトルを比較
function jpCompare(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const d = rankOf(A[i]) - rankOf(B[i]);
    if (d !== 0) return d;
  }
  return A.length - B.length;
}

export default function Home() {
  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [fields, setFields] = useState<GroupField[]>([]);
  const [doneProp, setDoneProp] = useState<string | null>(null);
  const [priceProp, setPriceProp] = useState<string | null>(null);
  // チェック⇄状態 連動用
  const [statusProp, setStatusProp] = useState<string | null>(null);
  const [statusComplete, setStatusComplete] = useState<string | null>(null);
  const [statusCompleteSet, setStatusCompleteSet] = useState<Set<string>>(new Set());
  const [statusTodo, setStatusTodo] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // オフライン対応
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);

  const [query, setQuery] = useState("");
  const [hideDone, setHideDone] = useState(false);
  const [groupBy, setGroupBy] = useState<string>(NO_GROUP);

  // テーマ(自動 / ライト / ダーク)
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");

  // 折り畳み(詳細)の展開状態と、遅延取得した本文
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<
    Record<string, Detail>
  >({});

  // 取得データ(サーバー/キャッシュ共通)を画面状態へ反映
  function applyData(data: Partial<CachedData> & Partial<ItemsResponse>, fromCache: boolean) {
    setItems(data.items ?? []);
    setFields(data.fields ?? []);
    setDoneProp(data.doneProp ?? null);
    setPriceProp(data.priceProp ?? null);
    setStatusProp(data.statusProp ?? null);
    setStatusComplete(data.statusCompleteValue ?? null);
    setStatusCompleteSet(new Set(data.statusCompleteValues ?? []));
    setStatusTodo(data.statusTodoValue ?? null);
    setDemo(data.demo ?? false);
    if (fromCache) {
      setGroupBy(data.defaultGroup ?? NO_GROUP);
    } else {
      setGroupBy((prev) =>
        prev !== NO_GROUP && (data.fields ?? []).some((f) => f.name === prev)
          ? prev
          : data.defaultGroup ?? NO_GROUP
      );
    }
  }

  // 溜まった更新をNotionへ順次同期。失敗(オフライン等)したらそこで中断して保持。
  async function flushQueue(): Promise<boolean> {
    const q = loadQueue();
    if (q.length === 0) {
      setPending(0);
      return true;
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setOnline(false);
      setPending(q.length);
      return false;
    }
    for (let i = 0; i < q.length; i++) {
      try {
        const res = await fetch("/api/items", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "update", id: q[i].id, props: q[i].props }),
        });
        if (!res.ok) throw new Error();
      } catch {
        const remaining = q.slice(i);
        saveQueue(remaining);
        setPending(remaining.length);
        setOnline(false);
        return false;
      }
    }
    saveQueue([]);
    setPending(0);
    return true;
  }

  // オンライン時: キュー同期 → 最新取得。オフライン時: キャッシュのまま。
  async function refresh() {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setOnline(false);
      setLoading(false);
      return;
    }
    setOnline(true);
    const synced = await flushQueue();
    if (!synced) {
      setLoading(false);
      return; // 同期しきれていないので取得はスキップ(ローカルを優先)
    }
    try {
      const res = await fetch("/api/items", { cache: "no-store" });
      const data: ItemsResponse = await res.json();
      if (data.error && !(data.items && data.items.length)) {
        setError(data.error);
      } else {
        applyData(data, false);
        setError(data.error ?? null);
      }
    } catch {
      setOnline(false);
    } finally {
      setLoading(false);
    }
  }

  // 初回: キャッシュを即描画 → オンラインなら最新化
  useEffect(() => {
    const cached = loadCache();
    if (cached) {
      applyData(cached, true);
      setLoading(false);
    }
    setPending(loadQueue().length);
    if (typeof navigator !== "undefined") setOnline(navigator.onLine);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // テーマ: 起動時に保存値を復元
  useEffect(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark" || saved === "system") setTheme(saved);
  }, []);

  // テーマ: 選択を <html data-theme> へ反映し保存。自動時は OS 設定に追従。
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && mq.matches);
      if (dark) root.setAttribute("data-theme", "dark");
      else root.removeAttribute("data-theme");
    };
    apply();
    localStorage.setItem("theme", theme);
    if (theme === "system") {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);

  // オンライン/オフラインの変化に追従
  useEffect(() => {
    function onOnline() {
      setOnline(true);
      refresh();
    }
    function onOffline() {
      setOnline(false);
    }
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 画面状態が変わるたびにキャッシュへ保存(オフライン閲覧用)
  useEffect(() => {
    if (loading) return;
    saveCache({
      items,
      fields,
      doneProp,
      priceProp,
      statusProp,
      statusCompleteValue: statusComplete,
      statusCompleteValues: [...statusCompleteSet],
      statusTodoValue: statusTodo,
      defaultGroup: groupBy,
      demo,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, fields, groupBy, doneProp, priceProp, statusProp, statusComplete, statusTodo, demo, loading]);

  const fieldMap = useMemo(() => {
    const m = new Map<string, GroupField>();
    for (const f of fields) m.set(f.name, f);
    return m;
  }, [fields]);

  function optionColor(fieldName: string, value: string) {
    const f = fieldMap.get(fieldName);
    const opt = f?.options.find((o) => o.name === value);
    return colorFor(opt?.color);
  }

  // 更新はまずキューに積んでから同期を試みる。
  // オフラインなら溜めておき、オンライン復帰時に自動同期(画面は楽観的に更新済み)。
  async function sendUpdate(
    id: string,
    props: { name: string; type: string; value: any }[]
  ) {
    if (demo || props.length === 0) return; // デモは書き込まない
    const op: QueueOp = { id, props };
    enqueue(op);
    setPending(loadQueue().length);
    await flushQueue();
  }

  // 完了チェック: チェックと「状態」を1回でまとめて更新(連動)
  async function toggleDone(item: ShoppingItem) {
    const next = !item.done;
    const linkStatus = Boolean(statusProp && statusComplete);
    const nextStatus = next ? statusComplete : statusTodo;

    setItems((prev) =>
      prev.map((it) =>
        it.id === item.id
          ? {
              ...it,
              done: next,
              values: linkStatus
                ? { ...it.values, [statusProp!]: nextStatus ? [nextStatus] : [] }
                : it.values,
            }
          : it
      )
    );

    const props: { name: string; type: string; value: any }[] = [];
    if (doneProp) props.push({ name: doneProp, type: "checkbox", value: next });
    if (linkStatus) props.push({ name: statusProp!, type: "status", value: nextStatus });
    await sendUpdate(item.id, props);
  }

  // 状態タグの変更: 「状態」列なら完了チェックも自動で連動させる
  async function changeField(item: ShoppingItem, field: GroupField, value: string) {
    const syncDone = field.name === statusProp && doneProp;
    const nextDone = syncDone ? statusCompleteSet.has(value) : item.done;

    setItems((prev) =>
      prev.map((it) =>
        it.id === item.id
          ? {
              ...it,
              done: syncDone ? nextDone : it.done,
              values: { ...it.values, [field.name]: value ? [value] : [] },
            }
          : it
      )
    );

    const props: { name: string; type: string; value: any }[] = [
      { name: field.name, type: field.type, value },
    ];
    if (syncDone) props.push({ name: doneProp!, type: "checkbox", value: nextDone });
    await sendUpdate(item.id, props);
  }

  async function toggleDetail(item: ShoppingItem) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
    // 開くとき&未取得なら本文を遅延ロード(署名URLは都度取得)
    if (!expanded.has(item.id) && !details[item.id]) {
      setDetails((prev) => ({
        ...prev,
        [item.id]: { loading: true, images: [], texts: [] },
      }));
      try {
        const res = await fetch(`/api/items/${item.id}`, { cache: "no-store" });
        const data = await res.json();
        setDetails((prev) => ({
          ...prev,
          [item.id]: {
            loading: false,
            images: data.images ?? [],
            texts: data.texts ?? [],
            error: data.error,
          },
        }));
      } catch (e: any) {
        setDetails((prev) => ({
          ...prev,
          [item.id]: {
            loading: false,
            images: [],
            texts: [],
            error: e?.message ?? "取得に失敗しました",
          },
        }));
      }
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = items.filter((it) => {
      if (hideDone && it.done) return false;
      if (!q) return true;
      const hay = [
        it.title,
        it.note ?? "",
        ...Object.values(it.values).flat(),
        ...it.extra.map((e) => e.value),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
    // 基本並び順: タイトルを50音順(濁音・半濁音は後ろ)
    return list.sort((a, b) => jpCompare(a.title, b.title));
  }, [items, query, hideDone]);

  const grouped = useMemo(() => {
    if (groupBy === NO_GROUP) return [[UNSET, filtered]] as [string, ShoppingItem[]][];
    const map = new Map<string, ShoppingItem[]>();
    for (const it of filtered) {
      const key = it.values[groupBy]?.[0] || UNSET;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(it);
    }
    const field = fieldMap.get(groupBy);
    // Notion の選択肢の並び順を尊重し、未設定は最後
    const order = field ? field.options.map((o) => o.name) : [];
    return Array.from(map.entries()).sort((a, b) => {
      if (a[0] === UNSET) return 1;
      if (b[0] === UNSET) return -1;
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      if (ia !== -1 && ib !== -1) return ia - ib;
      return a[0].localeCompare(b[0], "ja");
    });
  }, [filtered, groupBy, fieldMap]);

  const total = items.length;
  const doneCount = items.filter((it) => it.done).length;
  const remainingPrice = useMemo(
    () => items.filter((it) => !it.done).reduce((s, it) => s + (it.price ?? 0), 0),
    [items]
  );
  const hasPrice = priceProp != null && items.some((it) => it.price != null);
  const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");

  const showGroupHeader = groupBy !== NO_GROUP;

  return (
    <div className="container">
      <header className="header">
        <h1 className="title">🛒 買い物リスト</h1>
        <div className="stats">
          {total > 0 && (
            <span className="progress">
              {doneCount} / {total} 完了
            </span>
          )}
          {hasPrice && (
            <span className="total" title="未購入アイテムの合計金額">
              残り {yen(remainingPrice)}
            </span>
          )}
          {!online && <span className="pill offline">● オフライン</span>}
          {pending > 0 && (
            <span className="pill pending" title="Notion 未同期の変更">
              未同期 {pending}
            </span>
          )}
        </div>
      </header>

      {demo && (
        <div className="banner">
          <strong>デモモードで表示中です。</strong> 自分の Notion とつなぐには{" "}
          <code>.env.local</code> に <code>NOTION_TOKEN</code> と{" "}
          <code>NOTION_DATABASE_ID</code> を設定してください。
        </div>
      )}
      {error && !demo && (
        <div className="banner error">
          <strong>取得エラー:</strong> {error}
        </div>
      )}

      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="🔍 検索(品名・タグ・メモ)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {fields.length > 0 && (
          <label className="group-select">
            <span>グループ</span>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              <option value={NO_GROUP}>なし</option>
              {fields.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          className={`btn ${hideDone ? "active" : ""}`}
          onClick={() => setHideDone((v) => !v)}
        >
          {hideDone ? "☑ 購入済みを隠す" : "購入済みを隠す"}
        </button>
        <button
          className="btn"
          onClick={() =>
            setTheme((t) => (t === "system" ? "light" : t === "light" ? "dark" : "system"))
          }
          title="テーマ切替(自動 → ライト → ダーク)"
        >
          {theme === "system" ? "🌓 自動" : theme === "light" ? "☀️ ライト" : "🌙 ダーク"}
        </button>
        <button
          className="btn"
          onClick={refresh}
          title={pending > 0 ? "同期して再読み込み" : "再読み込み"}
        >
          {pending > 0 ? `↻ 同期(${pending})` : "↻"}
        </button>
      </div>

      {loading ? (
        <div className="spinner" aria-label="読み込み中" />
      ) : filtered.length === 0 ? (
        <div className="empty">
          {items.length === 0
            ? "アイテムがありません。"
            : "条件に一致するアイテムがありません。"}
        </div>
      ) : (
        grouped.map(([group, list]) => {
          const gc = showGroupHeader ? optionColor(groupBy, group) : null;
          return (
            <section className="category" key={group}>
              {showGroupHeader && (
                <div className="category-head">
                  <span
                    className="group-chip"
                    style={gc ? { background: gc.bg, color: gc.fg } : undefined}
                  >
                    {group}
                  </span>
                  <span className="category-count">
                    {list.filter((i) => !i.done).length}件
                    {hasPrice &&
                      ` · ${yen(
                        list.filter((i) => !i.done).reduce((s, i) => s + (i.price ?? 0), 0)
                      )}`}
                  </span>
                </div>
              )}
              <ul className="list">
                {list.map((item) => (
                  <li
                    key={item.id}
                    className={`item ${
                      item.done
                        ? "done"
                        : item.values[PRIORITY_FIELD]?.includes(PRIORITY_HIGH)
                        ? "prio-high"
                        : ""
                    }`}
                  >
                    <input
                      className="checkbox"
                      type="checkbox"
                      checked={item.done}
                      onChange={() => toggleDone(item)}
                      aria-label={`${item.title} を購入済みにする`}
                    />
                    <div className="item-body">
                      <div className="item-row">
                        <span className="item-title">{item.title}</span>
                        {item.price != null && (
                          <span className="price">{yen(item.price)}</span>
                        )}
                      </div>

                      <div className="item-meta">
                        {/* 編集可能な単一値フィールド(状態など)はドロップダウン */}
                        {fields
                          .filter((f) => f.editable)
                          .map((f) => {
                            const cur = item.values[f.name]?.[0] ?? "";
                            const c = optionColor(f.name, cur);
                            return (
                              <select
                                key={f.name}
                                className="tag-select"
                                value={cur}
                                title={f.name}
                                style={cur ? { background: c.bg, color: c.fg } : undefined}
                                onChange={(e) => changeField(item, f, e.target.value)}
                              >
                                <option value="">— {f.name} —</option>
                                {f.options.map((o) => (
                                  <option key={o.name} value={o.name}>
                                    {o.name}
                                  </option>
                                ))}
                              </select>
                            );
                          })}

                        {/* multi_select(ジャンル・優先度など)は色付きチップ */}
                        {fields
                          .filter((f) => !f.editable)
                          .flatMap((f) =>
                            (item.values[f.name] ?? []).map((v) => {
                              const c = optionColor(f.name, v);
                              return (
                                <span
                                  key={f.name + ":" + v}
                                  className="tag"
                                  style={{ background: c.bg, color: c.fg }}
                                >
                                  {v}
                                </span>
                              );
                            })
                          )}

                        {item.note && <span className="note">{item.note}</span>}
                        {item.extra.map((ex) => (
                          <span key={ex.name} className="extra">
                            {ex.name}: {ex.value}
                          </span>
                        ))}

                        <button
                          className="detail-toggle"
                          onClick={() => toggleDetail(item)}
                          aria-expanded={expanded.has(item.id)}
                        >
                          {expanded.has(item.id) ? "詳細を閉じる ▲" : "詳細 ▾"}
                        </button>
                      </div>

                      {expanded.has(item.id) && (
                        <div className="detail">
                          {item.links.length > 0 && (
                            <div className="detail-links">
                              {item.links.map((l) => (
                                <a
                                  key={l.label}
                                  className="detail-link"
                                  href={l.url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {l.label} ↗
                                </a>
                              ))}
                            </div>
                          )}
                          {details[item.id]?.loading && (
                            <div className="detail-loading">
                              <span className="spinner-sm" /> 読み込み中…
                            </div>
                          )}
                          {details[item.id] && !details[item.id].loading && (
                            <>
                              {details[item.id].images.length > 0 && (
                                <div className="detail-images">
                                  {details[item.id].images.map((img, i) => (
                                    <a
                                      key={i}
                                      href={img.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      title={img.caption || "画像を開く"}
                                    >
                                      {/* eslint-disable-next-line @next/next/no-img-element */}
                                      <img
                                        src={img.url}
                                        alt={img.caption || item.title}
                                        loading="lazy"
                                      />
                                    </a>
                                  ))}
                                </div>
                              )}
                              {details[item.id].texts.length > 0 && (
                                <div className="detail-texts">
                                  {details[item.id].texts.map((t, i) => (
                                    <p key={i}>{t}</p>
                                  ))}
                                </div>
                              )}
                              {details[item.id].error && (
                                <div className="detail-empty">
                                  取得に失敗しました: {details[item.id].error}
                                </div>
                              )}
                              {!details[item.id].error &&
                                details[item.id].images.length === 0 &&
                                details[item.id].texts.length === 0 &&
                                item.links.length === 0 && (
                                  <div className="detail-empty">
                                    このアイテムに詳細(画像・本文・リンク)はありません。
                                  </div>
                                )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}

      <footer className="footer">
        Notion 連携 買い物リスト{demo ? "(デモ)" : ""}
      </footer>
    </div>
  );
}
