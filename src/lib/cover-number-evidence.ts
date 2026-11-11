/** Exact number spelling normalization. This does not infer semantic facts. */
export type CoverNumericClaim = { raw: string; value: string; unit: string; negative: boolean; context: string; start: number; end: number };
const digits: Record<string, string> = { 零: "0", 〇: "0", 一: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };
const small: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const large: Record<string, number> = { 万: 10000, 亿: 100000000 };
const units: ReadonlyArray<readonly [string, string]> = [
  ["毫升", "ml"], ["mL", "ml"], ["ml", "ml"], ["升", "L"], ["L", "L"],
  ["毫克", "mg"], ["mg", "mg"], ["千克", "kg"], ["公斤", "kg"], ["kg", "kg"], ["克", "g"], ["g", "g"],
  ["毫米", "mm"], ["mm", "mm"], ["厘米", "cm"], ["cm", "cm"], ["米", "m"], ["m", "m"],
  ["分钟", "minute"], ["小时", "hour"], ["秒", "second"], ["天", "day"], ["周", "week"], ["个月", "month"], ["月", "month"], ["年", "year"],
  ["美元", "USD"], ["人民币", "CNY"], ["元", "CNY"], ["块", "CNY"], ["岁", "age"],
  ...["人", "个", "件", "条", "次", "倍", "页", "章", "台", "只", "张", "瓶", "包", "箱", "套", "种", "款", "份", "杯", "分"].map(value => [value, value] as const),
];
function decimal(raw: string): string | null {
  const clean = raw.replaceAll(",", "");
  if (!/^\d+(?:\.\d+)?$/u.test(clean)) return null;
  const [integer, fraction = ""] = clean.split(".");
  const whole = integer.replace(/^0+(?=\d)/u, ""), tail = fraction.replace(/0+$/u, "");
  return tail ? `${whole}.${tail}` : whole;
}
function chinese(raw: string): string | null {
  const [integer, fraction] = raw.split("点");
  if (fraction !== undefined && (!fraction || [...fraction].some(char => !Object.hasOwn(digits, char)))) return null;
  let total = BigInt(0), section = BigInt(0), pending: bigint | null = null, lastUnit = 10000, zero = false;
  if (!/[十百千万亿]/u.test(integer)) {
    if (integer.length > 1 && !/^[零〇]/u.test(integer)) return null;
    const spelled = [...integer].map(char => digits[char]).join("");
    return spelled && [...integer].every(char => Object.hasOwn(digits, char)) ? decimal(`${spelled}${fraction === undefined ? "" : `.${[...fraction].map(char => digits[char]).join("")}`}`) : null;
  }
  for (const char of integer) {
    if (Object.hasOwn(digits, char)) {
      if (digits[char] === "0") { if (pending !== null) return null; zero = true; continue; }
      if (pending !== null) return null;
      pending = BigInt(digits[char]);
    } else if (small[char]) {
      if (small[char] >= lastUnit || (pending === null && !(char === "十" && section === BigInt(0)))) return null;
      section += (pending ?? BigInt(1)) * BigInt(small[char]); pending = null; lastUnit = small[char]; zero = false;
    } else if (large[char]) {
      const block = section + (pending ?? BigInt(0));
      if (block === BigInt(0)) return null;
      if (char === "亿") total = (total + block) * BigInt(large[char]); else total += block * BigInt(large[char]);
      section = BigInt(0); pending = null; lastUnit = 10000; zero = false;
    } else return null;
  }
  // 一百二/一万二 are colloquial and ambiguous; require explicit 零/十.
  if (pending !== null && lastUnit >= 100 && (total > BigInt(0) || section > BigInt(0)) && !zero) return null;
  const value = (total + section + (pending ?? BigInt(0))).toString();
  return decimal(`${value}${fraction === undefined ? "" : `.${[...fraction].map(char => digits[char]).join("")}`}`);
}
const numericPattern = /(?:百分之)?[+\-−负正]?(?:\d+(?:,\d{3})*(?:\.\d+)?|[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二两三四五六七八九]+)?)(?:[%％])?/gu;
const normalizeWidths = (text: string) => text.replace(/[０-９]/gu, char => String(char.charCodeAt(0) - 0xff10));

export function coverNumericClaims(text: string): CoverNumericClaim[] {
  const input = normalizeWidths(text), claims: CoverNumericClaim[] = [];
  for (const match of input.matchAll(numericPattern)) {
    const start = match.index, end = start + match[0].length;
    const percent = match[0].startsWith("百分之") || /[%％]$/u.test(match[0]);
    let number = match[0].replace(/^百分之/u, "").replace(/[%％]$/u, "");
    const sign = /^[\-−负]/u.test(number) ? "-" : "";
    number = number.replace(/^[+\-−负正]/u, "");
    const suffix = input.slice(end), unitEntry = units.find(([unit]) => suffix.startsWith(unit));
    let unit = percent ? "percent" : unitEntry?.[1] || "";
    const chineseNumber = !/^\d/u.test(number);
    if (chineseNumber && unitEntry?.[0] === "分" && /^\p{Script=Han}/u.test(suffix.slice(1))) continue;
    // Do not interpret idioms such as 一心一意/十分开心 as measurements.
    if (chineseNumber && !percent && !unitEntry && (/[\p{L}\p{N}]/u.test(input[start - 1] || "") || /[\p{L}\p{N}]/u.test(input[end] || ""))) continue;
    let value = chineseNumber ? chinese(number) : decimal(number);
    if (value === null) { claims.push({ raw: match[0], value: match[0], unit: "opaque", negative: false, context: "", start, end }); continue; }
    if (sign && value !== "0") value = `${sign}${value}`;
    const prefix = input.slice(0, start).split(/[，,。！？!?；;\n]/u).at(-1) || "";
    const local = prefix.split(/而是|但是|然而|不过/u).at(-1)?.slice(-12) || "";
    const negative = /不|没|未|无|非/u.test(local);
    let context = /第\s*$/u.test(prefix) ? "ordinal" : "";
    const price = /原价|现价|售价|成本|运费|优惠|补贴/u.exec(local)?.[0];
    if (price) context = price;
    if (/[-–—~～至到×x*]\s*$/u.test(prefix) || /^\s*[-–—~～至到×x*]/u.test(suffix)) context = "compound";
    if (!unit && /[¥￥]\s*$/u.test(prefix)) unit = "CNY";
    if (!unit && /\$\s*$/u.test(prefix)) unit = "USD";
    // Model/SKU identifiers remain literal; numeric normalization cannot alter them.
    if (/[A-Za-z_]/u.test(input[start - 1] || "") || (!unitEntry && /^[A-Za-z_]/u.test(suffix))) {
      const left = input.slice(0, start).match(/[A-Za-z0-9_.-]+$/u)?.[0] || "";
      const right = suffix.match(/^[A-Za-z0-9_.-]+/u)?.[0] || "";
      value = `${left}${match[0]}${right}`; unit = "identifier"; context = "";
    }
    claims.push({ raw: text.slice(start, end), value, unit, negative, context, start, end });
  }
  return claims;
}

export function coverNumbersAreGrounded(text: string, quotes: string): boolean {
  const evidence = coverNumericClaims(quotes);
  return coverNumericClaims(text).every(claim => evidence.some(source => claim.value === source.value && claim.unit === source.unit
    && claim.negative === source.negative && claim.context === source.context));
}
