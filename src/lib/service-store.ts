// 服务卡片存储层
// 管理可自由添加的 TTS/克隆服务实例
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { ServiceCard, TTSEngine } from '@/lib/types';
import { ENGINE_CONFIGS } from '@/lib/tts/engines';
import { atomicWriteJsonSync } from '@/lib/atomic-file';
import { isProductionRuntime, resolveAppDataFile } from '@/lib/runtime-paths';

function readJson<T>(file: string, defaultValue: T): T {
  try {
    if (!fs.existsSync(file)) {
      if (isProductionRuntime()) {
        throw new Error(`Required runtime data file is missing: ${file}`);
      }
      return defaultValue;
    }
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch (error) {
    if (isProductionRuntime()) throw error;
    return defaultValue;
  }
}

function writeJson<T>(file: string, data: T): void {
  atomicWriteJsonSync(file, data);
}

/** 获取所有服务卡片 */
export function getAllServiceCards(): ServiceCard[] {
  const cardsFile = resolveAppDataFile('service-cards.json');
  const stored = readJson<ServiceCard[]>(cardsFile, []);
  if (stored.length === 0) {
    if (isProductionRuntime()) return stored;
    // 首次初始化：为每个引擎生成默认卡片
    const defaults = createDefaultCards();
    writeJson(cardsFile, defaults);
    return defaults;
  }
  return stored.sort((a, b) => a.sortOrder - b.sortOrder);
}

/** 获取已启用的卡片 */
export function getEnabledCards(): ServiceCard[] {
  return getAllServiceCards().filter((c) => c.enabled);
}

/** 获取默认卡片 */
export function getDefaultCard(): ServiceCard | undefined {
  const cards = getEnabledCards();
  return cards.find((c) => c.isDefault) || cards[0];
}

/** 根据 ID 获取卡片 */
export function getCardById(id: string): ServiceCard | undefined {
  return getAllServiceCards().find((c) => c.id === id);
}

/** 创建卡片 */
export function createCard(data: Omit<ServiceCard, 'id' | 'createdAt' | 'updatedAt'>): ServiceCard {
  const list = getAllServiceCards();
  const now = new Date().toISOString();
  const card: ServiceCard = {
    ...data,
    id: uuidv4(),
    sortOrder: list.length,
    createdAt: now,
    updatedAt: now,
  };
  // 如果设为默认，取消其他默认
  if (card.isDefault) {
    list.forEach((c) => { c.isDefault = false; });
  }
  list.push(card);
  writeJson(resolveAppDataFile('service-cards.json'), list);
  return card;
}

/** 更新卡片 */
export function updateCard(id: string, patch: Partial<ServiceCard>): ServiceCard | undefined {
  const list = getAllServiceCards();
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) return undefined;
  // 如果设为默认，取消其他默认
  if (patch.isDefault) {
    list.forEach((c) => { c.isDefault = false; });
  }
  list[idx] = { ...list[idx], ...patch, id, updatedAt: new Date().toISOString() };
  writeJson(resolveAppDataFile('service-cards.json'), list);
  return list[idx];
}

/** 删除卡片 */
export function deleteCard(id: string): boolean {
  const list = getAllServiceCards();
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return false;
  // 如果删除的是默认卡片，将第一个设为默认
  const deleted = list.find((c) => c.id === id);
  if (deleted?.isDefault && next.length > 0) {
    next[0].isDefault = true;
  }
  writeJson(resolveAppDataFile('service-cards.json'), next);
  return true;
}

/** 创建默认卡片（每个引擎一个通用卡片） */
function createDefaultCards(): ServiceCard[] {
  const now = new Date().toISOString();
  const engines = Object.keys(ENGINE_CONFIGS) as TTSEngine[];
  return engines.map((engine, idx) => {
    const meta = ENGINE_CONFIGS[engine];
    const extraConfig: Record<string, string> = {};
    meta.extraConfigKeys.forEach((k) => {
      extraConfig[k.key] = k.placeholder || '';
    });
    return {
      id: `default-${engine}`,
      name: `${meta.name}`,
      engineType: engine,
      serviceType: meta.cloneSupported ? 'both' : 'tts',
      apiKey: '',
      extraConfig,
      costPrice: 0,
      retailPrice: 0,
      isDefault: idx === 0,
      enabled: meta.enabled,
      sortOrder: idx,
      createdAt: now,
      updatedAt: now,
    };
  });
}
