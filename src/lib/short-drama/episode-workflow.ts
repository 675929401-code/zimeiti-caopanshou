import type { JsonValue } from "./contracts";

type JsonRecord = Record<string, JsonValue>;

export interface EpisodeWorkflowIssue {
  status: 400 | 409;
  code: string;
  message: string;
}

const LOCKED_FIELDS = [
  "episodeNumber",
  "title",
  "logline",
  "content",
  "endingHook",
  "estimatedDurationSeconds",
] as const;

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function episodes(payload: JsonRecord): JsonRecord[] {
  const value = payload.episodes;
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function episodeKey(episode: JsonRecord, index: number): string {
  const value = episode.episodeNumber;
  return typeof value === "string" || typeof value === "number"
    ? `number:${String(value).trim()}`
    : `index:${index}`;
}

function isConfirmed(episode: JsonRecord): boolean {
  return episode.status === "confirmed";
}

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function lockedContentChanged(current: JsonRecord, next: JsonRecord): boolean {
  return LOCKED_FIELDS.some((field) => JSON.stringify(current[field]) !== JSON.stringify(next[field]));
}

export function validateEpisodeWorkflowTransition(input: {
  currentPayload: JsonRecord;
  nextPayload: JsonRecord;
  hasDownstreamData: boolean;
}): EpisodeWorkflowIssue | null {
  const currentEpisodes = episodes(input.currentPayload);
  const nextEpisodes = episodes(input.nextPayload);

  if (input.hasDownstreamData && nextEpisodes.length < currentEpisodes.length) {
    return {
      status: 409,
      code: "EPISODE_DOWNSTREAM_LOCKED",
      message: "项目已有分镜或成片，不能删除已有分集，以免镜头与集号错位",
    };
  }

  const nextByKey = new Map(nextEpisodes.map((episode, index) => [episodeKey(episode, index), episode]));
  for (let index = 0; index < currentEpisodes.length; index += 1) {
    const current = currentEpisodes[index];
    const next = nextByKey.get(episodeKey(current, index));
    if (!next) {
      if (input.hasDownstreamData || isConfirmed(current)) {
        return {
          status: 409,
          code: input.hasDownstreamData ? "EPISODE_DOWNSTREAM_LOCKED" : "EPISODE_CONFIRMED_DELETE",
          message: input.hasDownstreamData
            ? `第 ${index + 1} 集已有分镜或成片，不能删除或改换集号`
            : `第 ${index + 1} 集已定稿，请先取消定稿并保存后再删除`,
        };
      }
      continue;
    }
    if (lockedContentChanged(current, next) && (isConfirmed(current) || input.hasDownstreamData)) {
      return {
        status: 409,
        code: input.hasDownstreamData ? "EPISODE_DOWNSTREAM_LOCKED" : "EPISODE_CONFIRMED_LOCKED",
        message: input.hasDownstreamData
          ? `第 ${index + 1} 集已有分镜或成片，不能修改已有内容；可以继续追加新分集`
          : `第 ${index + 1} 集已定稿，请先取消定稿再修改内容`,
      };
    }
    if (isConfirmed(current) && !isConfirmed(next) && input.hasDownstreamData) {
      return {
        status: 409,
        code: "EPISODE_DOWNSTREAM_LOCKED",
        message: `第 ${index + 1} 集已有分镜或成片，不能取消定稿`,
      };
    }
  }

  if (input.hasDownstreamData && nextEpisodes.length > currentEpisodes.length) {
    const currentNumbers = currentEpisodes.map((episode, index) => Number(episode.episodeNumber) || index + 1);
    const maxCurrentNumber = currentNumbers.length > 0 ? Math.max(...currentNumbers) : 0;
    const appended = nextEpisodes.slice(currentEpisodes.length);
    for (let index = 0; index < appended.length; index += 1) {
      const expectedNumber = maxCurrentNumber + index + 1;
      if (Number(appended[index].episodeNumber) !== expectedNumber) {
        return {
          status: 409,
          code: "EPISODE_APPEND_SEQUENCE_INVALID",
          message: `续写只能从第 ${maxCurrentNumber + 1} 集开始连续追加，不能改写已有集号`,
        };
      }
    }
  }

  for (let index = 0; index < nextEpisodes.length; index += 1) {
    const episode = nextEpisodes[index];
    if (isConfirmed(episode) && !text(episode.content)) {
      return {
        status: 400,
        code: "EPISODE_CONTENT_REQUIRED",
        message: `第 ${index + 1} 集剧本内容为空，不能定稿`,
      };
    }
  }

  return null;
}

export function validateStoryboardEpisodeReadiness(
  payload: JsonRecord,
): EpisodeWorkflowIssue | null {
  const values = episodes(payload);
  if (values.length === 0) {
    return {
      status: 409,
      code: "EPISODE_REQUIRED_FOR_STORYBOARD",
      message: "请先建立并保存分集剧本，再创建分镜",
    };
  }

  for (let index = 0; index < values.length; index += 1) {
    const episode = values[index];
    if (!text(episode.content)) {
      return {
        status: 409,
        code: "EPISODE_CONTENT_REQUIRED_FOR_STORYBOARD",
        message: `第 ${index + 1} 集剧本内容为空，不能创建分镜`,
      };
    }
    if (!isConfirmed(episode)) {
      return {
        status: 409,
        code: "EPISODE_CONFIRM_REQUIRED_FOR_STORYBOARD",
        message: `第 ${index + 1} 集尚未定稿，请先完成并保存全部分集定稿`,
      };
    }
  }
  return null;
}
