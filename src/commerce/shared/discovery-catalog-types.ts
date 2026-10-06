import type {SavedPromptMetadata,SavedPromptReference} from '../server/user-prompts';

/** Published example data. This is never a provider execution receipt. */
export type DiscoveryKind='image'|'video'|'canvas';
export type DiscoveryAsset={assetRef:string;kind:string;role:string;name:string;mimeType:string;url:string;sha256:string;bytes:number;width?:number;height?:number;duration?:number;sourceUrl:string};
export type DiscoveryItem={id:string;kind:DiscoveryKind;title:string;description:string;coverUrl:string;coverWidth?:number;coverHeight?:number;sourceLikes:number;sourceViews?:number;sourceCreatedAt?:string;sourcePublishedAt:string;sourceUrl:string;capturedAt:string;assets:DiscoveryAsset[];snapshot:Record<string,unknown>};
export type DiscoveryCatalog={schema:1;capturedAt:string;items:DiscoveryItem[];order:{video:string[];image:string[];canvas:string[]};sourceSite:string;homeOrder?:{video:string[];image:string[];canvas:string[]};totalAvailable?:number};
export type DiscoveryDraft={title:string;prompt_text:string;context_type:'image'|'video';metadata_json:SavedPromptMetadata;reference_elements_json:SavedPromptReference[]};
export type DiscoveryCopyResult={operationId:string;itemId:string;status:'completed';kind:'image'|'video';draft:DiscoveryDraft}|{operationId:string;itemId:string;status:'completed';kind:'canvas';canvasId:string;executionReady:boolean;executionMode:'materialized-snapshot'|'review-required';warnings:string[]};
