// Notion の色名 → チップ表示用の色(背景/文字)。
// 明るいパステル背景 + 濃い文字なので、ライト/ダーク両テーマで読みやすい。
export const NOTION_COLORS: Record<string, { bg: string; fg: string }> = {
  default: { bg: "#e3e2e0", fg: "#37352f" },
  gray: { bg: "#e3e2e0", fg: "#37352f" },
  brown: { bg: "#eee0da", fg: "#4a3228" },
  orange: { bg: "#fadec9", fg: "#6b3a12" },
  yellow: { bg: "#fdecc8", fg: "#6b551a" },
  green: { bg: "#dbeddb", fg: "#1c3a29" },
  blue: { bg: "#d3e5ef", fg: "#183347" },
  purple: { bg: "#e8deee", fg: "#412454" },
  pink: { bg: "#f5e0e9", fg: "#5a1f3f" },
  red: { bg: "#ffe2dd", fg: "#6e2019" },
};

export function colorFor(name?: string): { bg: string; fg: string } {
  return NOTION_COLORS[name ?? "default"] ?? NOTION_COLORS.default;
}
