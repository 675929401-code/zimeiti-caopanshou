/** Public application data only. Provider credentials and compiled system prompts never belong here. */
/**
 * The current authorized benchmark catalogue exposes at most 30 image
 * references plus 10 audio references for one director turn.  This limit is
 * for script analysis; the selected video model still applies its own,
 * usually smaller, generation-reference limits when the script is executed.
 */
export const DIRECTOR_REFERENCE_LIMIT = 40;
export const DIRECTOR_AUDIO_MAX_SECONDS = 15;
export type DirectorSettings = {
  skillKey: string;
  selections: Record<string, string | string[] | boolean | number>;
  spokenLanguage: string;
  durationSeconds: number;
  generateAudio: boolean;
};
export type DirectorReference = { id: string; slot: string; instanceId?: string; name?: string; type?: string };
export type DirectorOutputProtocol = 'director-script/v1' | 'director-script/v2';
export type DirectorTurnContext = {
  conversationId: string;
  expectedScriptMessageId: string | null;
  operationId: string;
  settings: DirectorSettings;
  references: DirectorReference[];
  outputProtocol?: DirectorOutputProtocol;
};
export type DirectorScriptShot={id:string;start:number;end:number;visual:string;camera:string;referenceNumbers:number[];speech:string;ambient:string;foley:string;music:string};
export type DirectorScript={title:string;creativeDirection:string;factLedger?:{fact:string;source:'user'|'reference'|'creative';evidence:string}[];story:string;setting:string;characters?:{id:string;identity:string;appearance:string;wardrobe:string;relationships:string;continuity:string}[];materials:{referenceNumber:number;observation:string;inherit:string[];exclude:string[]}[];productContinuity?:string[];shots:DirectorScriptShot[];conversionClose?:string;preserve:string[];forbid:string[]};
export type DirectorReply={schema:DirectorOutputProtocol;replyType:'needs_input'|'script';skillKey:string;durationSeconds:number;spokenLanguage:string;generateAudio:boolean;questions:string[];script:DirectorScript|null};
export type DirectorBusinessResult={version:1;state:'needs_input'|'ready'|'invalid'|'legacy_unverified';sourceContentHash:string;displayText:string;generationText?:string;reply?:DirectorReply;error?:string};
export type DirectorMessage = {
  id: string;
  sequence: number;
  role: 'user' | 'assistant';
  content: string;
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'unknown';
  jobId: string;
  operationId: string;
  baseMessageId: string | null;
  createdAt: number;
  settings: DirectorSettings;
  references: DirectorReference[];
  error?: string;
  outputProtocol?: DirectorOutputProtocol;
  business?: DirectorBusinessResult;
  /** No amount is inferred from tokens or an estimated video price. */
  billing: { status: 'unconfirmed' };
};
export type DirectorConversation = {
  id: string;
  createdAt: number;
  updatedAt: number;
  latestScriptMessageId: string | null;
  activeJobId: string | null;
  settings: DirectorSettings;
  messages: DirectorMessage[];
  /** Historic, unvalidated pointer, retained only for already-created applications. */
  legacyLatestScriptMessageId?: string | null;
  businessProtocolVersion?: 1;
};
export type DirectorPage = Omit<DirectorConversation, 'messages'> & {
  messages: DirectorMessage[];
  hasMore: boolean;
  nextCursor: string | null;
};
export type DirectorVideoSettings = { aspectRatio: string; resolution: string; duration: number; generateAudio: boolean };
export type DirectorApplication = {
  id: string;
  conversationId: string;
  messageId: string;
  jobId: string;
  script: string;
  settings: DirectorSettings;
  sourceReferences: DirectorReference[];
  references: { id: string; slot: string }[];
  videoSettings: DirectorVideoSettings;
  createdAt: number;
  outputProtocol?: DirectorOutputProtocol;
  sourceContentHash?: string;
  /** Server-derived digest of the source job's release, prompt, route and model snapshot. */
  sourceConfigurationHash?: string;
};
export function matchingDirectorApplication(a: DirectorApplication | null | undefined, script: string, references: {id?:string;serverId?:string;slot:string}[], settings: DirectorVideoSettings) {
  if (!a || a.script !== script || a.videoSettings.aspectRatio !== settings.aspectRatio || a.videoSettings.resolution !== settings.resolution || a.videoSettings.duration !== settings.duration || a.videoSettings.generateAudio !== settings.generateAudio) return null;
  const refs=references.map(r=>({id:r.serverId||r.id,slot:r.slot}));
  return JSON.stringify(a.references) === JSON.stringify(refs) ? a : null;
}
