import { getImageModelCapabilities, type ImageModelIdentity } from "@/lib/image-model-capabilities";

export type ImageReferenceTransport =
  | "none"
  | "chat_inline_data"
  | "generations_url_array"
  | "edits_multipart_single"
  | "edits_multipart_array";

export type ImageProviderContract = {
  requestProtocol: "chat_completions" | "google_generate_content" | "images_generations" | "images_generations_async" | "images_edits";
  referenceTransport: ImageReferenceTransport;
  source: "configured" | "provider_binding" | "openai_compatible_default";
};

export class ImageProviderBindingError extends Error {
  readonly code = "IMAGE_PROTOCOL_BINDING_REQUIRED";

  constructor(message = "当前生图模型缺少显式接口协议绑定") {
    super(message);
    this.name = "ImageProviderBindingError";
  }
}

type ContractModel = ImageModelIdentity & {
  api_endpoint?: string | null;
};

const TRANSPORT_ALIASES: Record<string, ImageReferenceTransport> = {
  none: "none",
  chat_inline_data: "chat_inline_data",
  chat_completions_inline: "chat_inline_data",
  generations_url_array: "generations_url_array",
  images_generations_url_array: "generations_url_array",
  image_array: "generations_url_array",
  edits_multipart_single: "edits_multipart_single",
  openai_edits_single: "edits_multipart_single",
  edits_multipart_array: "edits_multipart_array",
  openai_edits_array: "edits_multipart_array",
};

function configuredString(config: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return "";
}

export function resolveImageProviderContract(model: ContractModel): ImageProviderContract {
  const config = model.api_protocol_config && typeof model.api_protocol_config === "object"
    && !Array.isArray(model.api_protocol_config) ? model.api_protocol_config : {};
  const configuredTransport = TRANSPORT_ALIASES[configuredString(
    config,
    "reference_transport",
    "image_reference_transport",
  )];
  const protocol = configuredString(config, "protocol", "protocol_type", "image_protocol");
  if (/^(?:images[_-]?generations?[_-]?async|secure[_-]?skill[_-]?(?:banana[_-]?)?images?[_-]?async)$/u.test(protocol)) {
    return {
      requestProtocol: "images_generations_async",
      referenceTransport: model.supports_image_input ? "generations_url_array" : "none",
      source: "configured",
    };
  }
  if (/google(?:[_-]?native)?(?:[_-]?generate[_-]?content)?|gemini[_-]?generate[_-]?content/u.test(protocol)) {
    return {
      requestProtocol: "google_generate_content",
      referenceTransport: "chat_inline_data",
      source: "configured",
    };
  }
  if (configuredTransport) {
    return {
      requestProtocol: configuredTransport === "chat_inline_data"
        ? "chat_completions"
        : configuredTransport.startsWith("edits_") ? "images_edits" : "images_generations",
      referenceTransport: configuredTransport,
      source: "configured",
    };
  }
  if (/chat(?:[_-]?completions)?(?:[_-]?image)?/u.test(protocol)) {
    return { requestProtocol: "chat_completions", referenceTransport: "chat_inline_data", source: "configured" };
  }
  if (/edit/u.test(protocol)) {
    const capabilities = getImageModelCapabilities(model);
    return {
      requestProtocol: "images_edits",
      referenceTransport: capabilities.referenceInputMode === "multi"
        ? "edits_multipart_array"
        : "edits_multipart_single",
      source: "configured",
    };
  }
  if (/generation|secure[_-]?skill[_-]?images/u.test(protocol)) {
    return {
      requestProtocol: "images_generations",
      referenceTransport: model.supports_image_input ? "generations_url_array" : "none",
      source: "configured",
    };
  }
  if (/openai[_-]?image|volcengine[_-]?images/u.test(protocol)) {
    return {
      requestProtocol: "images_generations",
      referenceTransport: model.supports_image_input ? "generations_url_array" : "none",
      source: "configured",
    };
  }

  // Never infer an upstream contract from host, provider label or model name.
  // The same relay origin can expose Google-native, Chat Completions and Images
  // APIs at the same time; inference here is exactly how one model used to
  // change another model's request path.
  throw new ImageProviderBindingError();
}

export function imageReferenceContractIssue(
  contract: ImageProviderContract,
  referenceCount: number,
) {
  if (referenceCount <= 0) return null;
  if (contract.referenceTransport === "none") {
    return { code: "IMAGE_REFERENCE_PROTOCOL_UNSUPPORTED", message: "当前渠道协议不支持参考图输入" };
  }
  if (referenceCount > 1 && contract.referenceTransport === "edits_multipart_single") {
    return { code: "IMAGE_REFERENCE_PROTOCOL_LIMIT_EXCEEDED", message: "当前渠道协议一次只支持一张参考图" };
  }
  return null;
}
