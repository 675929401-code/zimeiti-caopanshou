#!/usr/bin/env node
/**
 * 视频交付耐久性合同（零网络、零数据库）。
 *
 * 背景：普通视频交付曾只保留供应商临时 URL，不落平台副本；供应商 CDN
 * 在数小时内 404 后，历史记录全部变成不可播放的空壳。本检查把“终态必须
 * 尝试持久化平台副本”固化成可回归的合同，防止后续改动把持久化拿掉。
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];
const passes = [];

function read(relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) throw new Error(`missing file: ${relative}`);
  return fs.readFileSync(absolute, "utf8");
}

function check(name, fn) {
  try {
    fn();
    passes.push(name);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

check("video-terminal-finalizer 调度平台副本持久化", () => {
  const source = read("src/lib/video-terminal-finalizer.ts");
  if (!source.includes("scheduleVideoDeliveryPersistence")) {
    throw new Error("终态交付不再调用 scheduleVideoDeliveryPersistence");
  }
  if (!/if \(!usesPersistentCopy && providerResultUrl/.test(source)) {
    throw new Error("缺少“非持久副本时调度持久化”的分支");
  }
});

check("普通视频持久化使用 video-delivery 作用域", () => {
  const delivery = read("src/lib/video-delivery-persistence.ts");
  if (!delivery.includes('storageScope: "video-delivery"')) {
    throw new Error("持久化调用缺少 video-delivery 作用域");
  }
  const persistence = read("src/lib/video-persistence.ts");
  if (!persistence.includes('"video-delivery"')) {
    throw new Error("ManagedVideoStorageScope 未包含 video-delivery");
  }
});

check("持久化成功后写回 storage_url 与 video_url", () => {
  const source = read("src/lib/video-delivery-persistence.ts");
  for (const needle of ["storage_url: persisted", "video_url: persisted", 'is("source_expired_at", null)', 'is("history_hidden_at", null)']) {
    if (!source.includes(needle)) throw new Error(`缺少约束: ${needle}`);
  }
});

check("播放代理优先使用持久对象副本", () => {
  const proxy = read("src/app/api/video/proxy/route.ts");
  if (!proxy.includes("isPersistentVideoUri")) throw new Error("代理不再识别 object:// 持久副本");
  if (!proxy.includes("canRedirect")) throw new Error("代理缺少持久副本 302 分支");
});

check("普通视频终态不再只保留供应商 URL", () => {
  const finalizer = read("src/lib/video-terminal-finalizer.ts");
  if (finalizer.includes("not copied into permanent platform storage")) {
    throw new Error("仍保留“普通视频不落平台存储”的旧策略注释");
  }
});

console.log(`[video-delivery-durability] ${passes.length} passed`);
for (const name of passes) console.log(`  PASS ${name}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  console.error(`[video-delivery-durability] FAILED ${failures.length}`);
  process.exit(1);
}
console.log("[video-delivery-durability] PASS");
