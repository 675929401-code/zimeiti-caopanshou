export type VideoErrorCategory =
  | "account_quota"
  | "authentication"
  | "model_channel"
  | "provider_unavailable"
  | "rate_limited"
  | "asset_input"
  | "content_policy"
  | "configuration"
  | "unknown";

export interface ClassifiedVideoError {
  category: VideoErrorCategory;
  code: string;
  publicMessage: string;
  operatorMessage: string;
  retryable: boolean;
}

function compactError(value: unknown) {
  return String(value || "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2000);
}

/** Preserve an actionable operator error while removing credentials carried by URLs or headers. */
export function sanitizeVideoProviderDiagnostic(rawError: unknown): string {
  return compactError(rawError)
    .replace(/data:[^\s"'<>]+/giu, "[data-redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/giu, value => {
      try {
        const parsed = new URL(value);
        if (parsed.username || parsed.password) return "[url-redacted]";
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      } catch {
        return "[url-redacted]";
      }
    })
    .replace(/(bearer\s+)\S+/giu, "$1[redacted]")
    .replace(/((?:api[_\s-]?key|access[_\s-]?key|secret|token|authorization)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/\b[A-Za-z0-9+/_=-]{257,}(?=\s|$|["'<>])/gu, "[blob-redacted]")
    .slice(0, 500);
}

export function classifyVideoProviderError(
  rawError: unknown,
  publicModelName = "所选视频模型",
): ClassifiedVideoError {
  const operatorMessage = sanitizeVideoProviderDiagnostic(rawError) || "Unknown video provider failure";
  const normalized = operatorMessage.toLowerCase();

  if (/预扣费额度失败|渠道额度暂不可用|(?:额度|配额).*(?:不可用|不足|耗尽|等待恢复)|user quota is not enough|insufficient[_\s-]*(?:quota|balance|credits?|funds)|quota.*(?:not enough|exceeded|insufficient)|(?:balance|余额).*(?:insufficient|不足)|payment required|arrearage|\b402\b/iu.test(operatorMessage)) {
    return {
      category: "account_quota",
      code: "CHANNEL_QUOTA_UNAVAILABLE",
      publicMessage: `${publicModelName}的渠道额度暂不可用，请联系管理员检查该模型渠道账户`,
      operatorMessage,
      retryable: false,
    };
  }

  // Media retrieval errors belong to this task's input, not to API credentials.
  if (/需要.{0,20}首帧和尾帧|缺少.*尾帧/iu.test(operatorMessage)) {
    return { category: "asset_input", code: "VIDEO_FRAMES_REQUIRED", publicMessage: `${publicModelName}需要首帧和尾帧，请补齐两张图片`, operatorMessage, retryable: false };
  }
  if (/必须提供参考图|requires? (?:a )?reference image|缺少.*(?:首帧|参考图)/iu.test(operatorMessage)) {
    return { category: "asset_input", code: "VIDEO_REFERENCE_REQUIRED", publicMessage: `${publicModelName}需要参考图，请先上传图片`, operatorMessage, retryable: false };
  }
  if (/(?:download|fetch|read).{0,40}(?:video|image|audio)|(?:video|image|audio).{0,40}(?:download|fetch|read)|(?:下载|读取|获取).{0,20}(?:源视频|参考图|参考音频|素材)/iu.test(operatorMessage)
    && /403|forbidden|access.?denied|无法|失败|failed/iu.test(operatorMessage)) {
    return { category: "asset_input", code: "VIDEO_INPUT_UNAVAILABLE",
      publicMessage: publicModelName + "无法读取当前参考素材，请重新上传后重试", operatorMessage, retryable: false };
  }

  if (/渠道认证配置异常|invalid api.?key|invalid.?access.?key.?id|access.?denied|invalid token|unauthori[sz]ed|forbidden|authentication|\b401\b|\b403\b/iu.test(operatorMessage)) {
    return {
      category: "authentication",
      code: "CHANNEL_AUTH_INVALID",
      publicMessage: `${publicModelName}的渠道认证配置异常，请联系管理员检查该模型渠道配置`,
      operatorMessage,
      retryable: false,
    };
  }

  if (/当前没有可用通道|model[_\s-]?not[_\s-]?found|no available channel|unsupported model|model (?:is )?not (?:found|supported)|模型通道不可用|模型(?:不存在|已下架|不支持)|无可用(?:模型)?通道/iu.test(operatorMessage)) {
    return {
      category: "model_channel",
      code: "MODEL_CHANNEL_UNAVAILABLE",
      publicMessage: `${publicModelName}当前没有可用通道，请稍后重试；如持续出现请联系管理员检查该模型渠道配置`,
      operatorMessage,
      retryable: false,
    };
  }

  if (/未配置api|配置不完整|missing.*(?:endpoint|api.?key|model)|did not return a task id|未返回任务id/iu.test(operatorMessage)) {
    return {
      category: "configuration",
      code: "CHANNEL_CONFIGURATION_INCOMPLETE",
      publicMessage: `${publicModelName}的渠道配置不完整，请联系管理员处理`,
      operatorMessage,
      retryable: false,
    };
  }

  if (/invalid.?parameter|invalid.?file|input.?data.*(?:invalid|error)|bad.?request|requires? (?:a )?(?:reference image|source video)|必须.*(?:参考图|源视频)|(?:image|source.?video).*(?:https|url)|公网.*(?:图片|视频|url)|prompt.*2000|提示词.*2000|duration.*between|时长.*(?:必须|范围|支持)|不支持画面比例/iu.test(operatorMessage)) {
    let publicMessage = `${publicModelName}的请求参数不符合渠道要求，请检查参考图、时长和画面比例后重试`;
    if (/prompt.*2000|提示词.*2000/iu.test(operatorMessage)) {
      publicMessage = `${publicModelName}的视频提示词过长，请精简动作、运镜和声音指令后重试`;
    } else if (/duration.*between|时长.*(?:必须|范围|支持)/iu.test(operatorMessage)) {
      publicMessage = `${publicModelName}暂不接受所选时长，请更换该模型支持的时长后重试`;
    } else if (/source.?video|源视频/iu.test(operatorMessage)) {
      publicMessage = `${publicModelName}必须先上传一条公网可访问的源视频后才能使用`;
    } else if (/reference image|参考图|image.*(?:https|url)|公网.*(?:图片|url)/iu.test(operatorMessage)) {
      publicMessage = `${publicModelName}无法读取当前参考图，请换用可公开访问的图片后重试`;
    } else if (/不支持画面比例/iu.test(operatorMessage)) {
      publicMessage = `${publicModelName}暂不支持当前画面比例，请更换比例后重试`;
    }
    return {
      category: "asset_input",
      code: "VIDEO_INPUT_INVALID",
      publicMessage,
      operatorMessage,
      retryable: false,
    };
  }

  if (/\bPUBLIC_ERROR_AUDIO_FILTERED\b|音频.{0,12}未通过审核/iu.test(operatorMessage)) {
    return {
      category: "content_policy",
      code: "VIDEO_AUDIO_CONTENT_REJECTED",
      publicMessage: `${publicModelName}生成的音频未通过审核，请调整声音描述或台词后重试`,
      operatorMessage,
      retryable: false,
    };
  }

  if (/data.?inspection.?failed|sensitive.?content|生成审核|content.?policy|content[_ -]?filter|public_error_(?:image|video|text)_filtered|moderation|safety|内容审核|违规|敏感/iu.test(operatorMessage)) {
    return {
      category: "content_policy",
      code: "VIDEO_CONTENT_REJECTED",
      publicMessage: `${publicModelName}的内容未通过生成审核，请调整提示词或参考图后重试`,
      operatorMessage,
      retryable: false,
    };
  }

  if (/throttl|rate limit|too many|限流|\b429\b/iu.test(operatorMessage)) {
    return {
      category: "rate_limited",
      code: "CHANNEL_RATE_LIMITED",
      publicMessage: `${publicModelName}的渠道请求较多，请稍后重试`,
      operatorMessage,
      retryable: true,
    };
  }

  if (/internal.?server.?error|internalerror|渠道服务暂时不可用|service unavailable|server_error|generation failed: generate error|暂不可用|不可达|network|网络|timeout|超时|econn|enotfound|\b502\b|\b503\b|http 5\d\d|服务端错误/iu.test(operatorMessage) || /\b5\d\d\b/u.test(normalized)) {
    return {
      category: "provider_unavailable",
      code: "CHANNEL_SERVICE_UNAVAILABLE",
      publicMessage: `${publicModelName}的渠道服务暂时不可用，请稍后重试；如持续出现请联系管理员检查该模型渠道服务`,
      operatorMessage,
      retryable: true,
    };
  }

  return {
    category: "unknown",
    code: "VIDEO_GENERATION_FAILED",
    publicMessage: `${publicModelName}生成失败，请稍后重试；如持续出现请联系管理员`,
    operatorMessage,
    retryable: true,
  };
}

/** Site account and input failures must not be labelled as supplier quota failures. */
export function localVideoTaskFailureMessage(code: unknown): string | undefined {
const localFailures:Record<string,string>={
        INSUFFICIENT_CASH_BALANCE:'本站钱包余额不足，请充值后重新生成。本次未扣费。',
        MEMBERSHIP_REQUIRED:'会员状态已失效，请激活或续费后重新生成。本次未扣费。',
        DIGITAL_ACCOUNT_UNAVAILABLE:'账号状态已变更，任务未提交，本次未扣费。',
        DIGITAL_MODEL_UNAVAILABLE:'所选模型暂时不可用，任务未提交，本次未扣费。',
        DIGITAL_MODEL_CONFIGURATION_CHANGED:'模型配置已更新，请重新选择后生成。本次未扣费。',
        DIGITAL_ASSET_UNAVAILABLE:'人物素材或配音暂时无法读取，请检查素材后重试。本次未扣费。',
        DIGITAL_ASSET_INPUT_CHANGED:'素材与原任务不一致，请检查素材后重试。本次未扣费。',
        VIDEO_SUBMISSION_CONFIRMATION_EXPIRED:'上游在确认时限内未返回任务编号，本次未扣费。可以重新生成。',
      };
return Object.prototype.hasOwnProperty.call(localFailures,String(code)) ? localFailures[String(code)] : undefined;
}
