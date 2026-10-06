'use client';
import {ImageEditorIcon} from './image-editor-icons';
import {ImageRailMenu} from './image-rail-menu';
import {imageRailSkillFromPath} from './image-rail-menu-data';
import {ImagePromptLine} from './image-prompt-line';
import {PromptAssist} from './prompt-assist';
import {DiscoveryGallery} from './discovery-gallery';
import {AssetPicker} from './asset-picker';
import {ImageReferenceControls} from './image-reference-controls';
import {imageEditorReferences,orderImageEditorMaterials,restoreImageEditorDocument,imageLegacyFilenameMentions} from './image-reference-editor';
import {createImageReferenceDocument,reconcileImageReferenceDocument,editImageReferenceDocument,applyImageReferenceTextEdit,completeImageReferenceUpload,validateImageReferenceDocument,type ImageReferenceDocument} from '../../shared/image-reference-mentions';
import {selectionError,type SelectionLimits} from './material-selection';
import {recoverMaterials as recoverWorkspaceMaterials,type MaterialReference} from './material-recovery';
import {ReferenceRecoveryState,type RecoveryAttempt,type RecoveryKind} from './reference-recovery-state';
import {getImageInputContract,validateImageInput} from '../../image-input-contract';
import {WorkspaceIdentity} from './workspace-identity';
import {workspaceOwnerKey} from './workspace-storage';
import {UserPromptLibrary,type UserPromptCapture} from './user-prompt-library';
import type {UserPrompt} from '../../server/user-prompts';
import {MediaTools} from './media-tools';
import {HotVideoRemixStudio} from './hot-video-remix-studio';
import {VoiceSynthesisStudio} from './voice-synthesis-studio';
import {availableModelId,videoModelCatalogUrl} from './model-selection';
import {matchingAssistApplication} from './assist-application';
import type {AssistApplication} from '../../server/prompt-assist-schema';
import {DIRECTOR_AUDIO_MAX_SECONDS,DIRECTOR_REFERENCE_LIMIT,matchingDirectorApplication,type DirectorApplication} from '../../server/director-conversation-schema';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { listMaterials as listOwnedMaterials, saveMaterial as saveOwnedMaterial, type StoredMaterial } from './material-store';
import { Home, Bot, Video, Image as ImageIcon, Grid2X2, FolderOpen, Plus, ArrowUp, ChevronDown, ChevronRight, X, Wand2, Scissors, Sparkles, Eraser, Captions, ScanFace, SlidersHorizontal, Upload, Download, Save, Search, Heart, Play, Check, FileText, ShoppingBag, Megaphone, Clock, RotateCcw, Shirt, UserRound, Package, Music, Expand, BookOpen, Coins, LayoutGrid, Mic2 } from 'lucide-react';
import { IMAGE_SKILLS, DIRECTOR_GROUPS, VIDEO_SLOTS, SCENARIOS, DETAIL_PANELS, TOOL_ITEMS, type CommerceTab, type MaterialSlot, type CommerceSkill } from './catalog';
import {useRuntime,TaskPreview,TaskQueue,ChatPanel,ServerAssets,api,type UIJob,type UIAsset} from './runtime-ui';
import './workspace.css';
import './delivery.css';
import './alignment.css';
import './image-visible-alignment.css';
import {CreationPicker,MediaSettings,ModelPopover,DirectorPanel,ImageExample,DIRECTORS,PUBLIC_UI,observedImage,slotFromObserved} from './reference-ui';
import {markSecondaryPageReturn} from '@/lib/marketplace-navigation';
import {
  commerceVideoResolutionOptions,
  commerceVideoSupportsAudioToggle,
  commerceVideoTargetDurations,
  COMMERCE_VIDEO_MAX_TOTAL_DURATION,
  resolveCommerceVideoDurationPlan,
} from '../../shared/video-generation-capabilities';

const CommerceCanvas = dynamic(() => import('./canvas-live').then(module => module.CommerceCanvas), { ssr: false, loading: () => <div className="ca-empty" role="status">正在加载画布…</div> });
const DetailSetStudio = dynamic(() => import('./detail-set-studio').then(module => module.DetailSetStudio), { ssr: false, loading: () => <div className="ca-empty" role="status">正在加载商详工作台…</div> });
const DepthVideoCloneStudio = dynamic(() => import('./depth-video-clone-studio').then(module => module.DepthVideoCloneStudio), { ssr: false, loading: () => <div className="ca-empty" role="status">正在加载深度复刻…</div> });
type Model = { id: string; selectionId?: string; displayName: string; publicPrice: number; capabilities: Record<string, unknown>; verified?: boolean; generationReady?: boolean; readinessMessage?: string; configurationSelectable?: boolean; selectionAvailable?: boolean; selectionCompatible?: boolean; selectionIncompatibleReasons?: string[]; modeCompatible?: boolean; modeIncompatibleReasons?: string[]; curatedProfileId?: string; curatedStatus?: string; tier?: number; tierLabel?: string };
type ModelKind = 'image' | 'video' | 'agent';
type CuratedProfile = { id: string; kind: ModelKind; label: string; status: 'selectable' | 'pending' | 'missing'; userVisible: boolean; boundModelId?: string | null; boundModelName?: string | null; statusMessage?: string; role?: string };
type ModelCatalogState = { configurationReady: boolean; configurationMessage: string; userSelectable: boolean; generationReadyCount: number; error: string; curatedProfiles: CuratedProfile[] };
type Material = { serverId?: string; id: string; name: string; url: string; type: string; size: number; slot: string };
type Product = { name: string; audience: string; sellingPoints: string; specifications: string; language: string };
type Draft = { id: string; title: string; kind: 'image' | 'video' | 'agent'; prompt: string; skillId: string; createdAt: number; modelId: string; aspectRatio: string; resolution: string; format: string; duration: number; materials: Array<{ id: string; name: string; type: string; slot: string;serverId?:string }>; imageReferenceDocument?:ImageReferenceDocument; scriptSourceJobId?:string; assistApplication?:AssistApplication; directorApplication?:DirectorApplication; helperConversationId?:string; helperMode?:boolean; helperPrompt?:string; scriptLanguage?:string; scriptDuration?:number; generateAudio?:boolean; director?: string; agent?: { scenarioId: string; product: Product; panels: string[]; confirmed: boolean } };
const MENU = [{ key: 'home', name: '首页', Icon: Home }, { key: 'agent', name: 'Agent', Icon: Bot }, { key: 'video', name: 'AI视频', Icon: Video }, { key: 'image', name: 'AI图片', Icon: ImageIcon }, { key: 'canvas', name: '画布', Icon: Grid2X2 }, { key: 'assets', name: '资产', Icon: FolderOpen }] as const;
const TOOL_ICONS = [Grid2X2, Scissors, Sparkles, Eraser, Captions, ScanFace, Wand2, UserRound, Play, Mic2];
const SCENARIO_ICONS = [Video, ImageIcon, ShoppingBag, Play, Megaphone, Video];
const accepts = (slot: MaterialSlot) => slot.kinds.map(kind => kind === 'image' ? 'image/png,image/jpeg,image/webp' : kind === 'video' ? 'video/mp4,video/webm,video/quicktime' : 'audio/*').join(',');
const fileKind = (type: string) => type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : '';
const emptyCatalogState=():ModelCatalogState=>({configurationReady:false,configurationMessage:'模型目录正在读取',userSelectable:false,generationReadyCount:0,error:'',curatedProfiles:[]});
const canConfigureModel=(item:Model)=>item.configurationSelectable??item.selectionAvailable??true;
const modelSelectionId=(item:Model)=>item.selectionId||item.id;
function configuredModelId(items:Model[],current?:string,preferred?:string){
  const selectable=items.filter(canConfigureModel);
  const selected=selectable.find(item=>modelSelectionId(item)===current||item.id===current)
    ||selectable.find(item=>(modelSelectionId(item)===preferred||item.id===preferred)&&item.modeCompatible!==false&&item.selectionCompatible!==false)
    ||selectable.find(item=>item.modeCompatible!==false&&item.selectionCompatible!==false)
    ||selectable[0];
  return selected?modelSelectionId(selected):'';
}
function videoModelConfigurationHint(item:Model){
  const caps=item.capabilities,maxImages=Number(caps.maxReferenceImages??0),maxAudios=Number(caps.maxReferenceAudios??0);
  const resolutions=commerceVideoResolutionOptions(caps).options;
  const declaredDurations=Array.isArray(caps.nativeDurations)?caps.nativeDurations:Array.isArray(caps.durationOptions)?caps.durationOptions:[];
  const nativeDurations=[...new Set(declaredDurations.map(Number).filter(value=>Number.isFinite(value)&&value>0))].sort((left,right)=>left-right);
  const inputs=[maxImages>0?`最多 ${maxImages} 张参考图`:'不接收参考图',caps.supportsSourceVideoInput===true?'支持源视频':'',maxAudios>0?`最多 ${maxAudios} 段声音参考`:''].filter(Boolean);
  return [`清晰度 ${resolutions.length?resolutions.join('/'):'由模型决定'}`,`原生 ${nativeDurations.join('/')||'未声明'} 秒`,...inputs,commerceVideoSupportsAudioToggle(caps)?'可切换含音频/静音':'跟随模型默认音频'].join(' · ');
}
function pickerModels(items:Model[],kind?:ModelKind){return items.map(item=>{const max=Number(item.capabilities.maxReferenceImages??0),supportsReferences=item.capabilities.supportsImageInput===true||item.capabilities.supportsReferenceInput===true;const configurationHint=kind==='image'?(supportsReferences?max>0?`最多 ${max} 张参考图`:'支持参考图':'仅文字生图，不支持参考图'):kind==='video'?videoModelConfigurationHint(item):undefined;const incompatibleReasons=[...new Set([...(item.modeIncompatibleReasons||[]),...(item.selectionIncompatibleReasons||[])].filter(Boolean))];return {...item,id:modelSelectionId(item),configurationHint,modeCompatible:item.modeCompatible!==false&&item.selectionCompatible!==false,modeIncompatibleReasons:incompatibleReasons,capabilities:{...item.capabilities,available:canConfigureModel(item)}};});}
const prettyDate = (at: number) => new Date(at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const COMMERCE_BASE_PATH='/commerce';
function commerceInternalPath(path:string){
  const url=new URL(path,'http://commerce.local');
  const pathname=url.pathname===COMMERCE_BASE_PATH?'/':url.pathname.startsWith(COMMERCE_BASE_PATH+'/')?url.pathname.slice(COMMERCE_BASE_PATH.length):url.pathname;
  return pathname+url.search;
}
function commerceBrowserPath(path:string){
  const url=new URL(commerceInternalPath(path),'http://commerce.local');
  return (url.pathname==='/'?COMMERCE_BASE_PATH:COMMERCE_BASE_PATH+url.pathname)+url.search;
}

export function CommerceWorkspace() {
  return <WorkspaceIdentity>{ownerKey=><CommerceBody key={ownerKey} ownerKey={ownerKey}/>}</WorkspaceIdentity>;
}

function CommerceBody({ ownerKey }: { ownerKey: string }) {
  const recoverMaterials=(refs:MaterialReference[],signal?:AbortSignal)=>recoverWorkspaceMaterials(refs,ownerKey,signal);
  const listMaterials=()=>listOwnedMaterials(ownerKey);
  const saveMaterial=(value:StoredMaterial)=>saveOwnedMaterial(value,ownerKey);
  const [tab, setTab] = useState<CommerceTab>('home');
  const [directorCards, setDirectorCards] = useState(DIRECTORS);
  const [prompts, setPromptValues] = useState<Record<string, string>>({ home: '', image: '', video: '', agent: '' });
  const promptValues=useRef(prompts);promptValues.current=prompts;
  const [imageDocument,setImageDocument]=useState<ImageReferenceDocument>({version:1,text:'',mentions:[]});const imageDocumentRef=useRef(imageDocument);const imageSkillRef=useRef('default');const imageTextarea=useRef<HTMLTextAreaElement>(null);
  const setPrompts=(value:Record<string,string>|((previous:Record<string,string>)=>Record<string,string>))=>{const next=typeof value==='function'?value(promptValues.current):value;if(next.image!==imageDocumentRef.current.text){const doc=editImageReferenceDocument(imageDocumentRef.current,next.image,imageEditingReferences(),imageSlotOrder());imageDocumentRef.current=doc;setImageDocument(doc);next.image=doc.text;}promptValues.current=next;setPromptValues(next);};
  const promptKey = tab === 'home' ? 'home' : tab === 'video' ? 'video' : tab === 'agent' ? 'agent' : 'image';
  const prompt = prompts[promptKey];
  const setPrompt = (value: string | ((previous: string) => string)) => setPrompts(current => ({ ...current, [promptKey]: typeof value === 'function' ? value(current[promptKey]) : value }));
  const [homeMode, setHomeMode] = useState<'agent' | 'image' | 'video'>('agent');
  const [skillId, setSkillId] = useState('default');
  const [skillOpen, setSkillOpen] = useState(false);
  useEffect(()=>{let alive=true;fetch('/api/commerce/v1/director-catalog').then(r=>r.ok?r.json():null).then(d=>{if(alive&&d&&Array.isArray(d.directors)&&d.directors.length)setDirectorCards(d.directors);}).catch(()=>{});return ()=>{alive=false};},[]);
  const [skillSearch, setSkillSearch] = useState('');
  const [directorOpen, setDirectorOpen] = useState(false);
  const [assistId,setAssistId]=useState('');
  const [director, setDirector] = useState('default-director');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelOpen,setModelOpen]=useState(false);
  const [editorExpanded,setEditorExpanded]=useState(false);const [announceShow,setAnnounceShow]=useState(()=>{try{return localStorage.getItem('ca-announce-20260912')!=='1';}catch{return true;}});
  const [scriptLanguage,setScriptLanguage]=useState('中文');
  const [scriptDuration,setScriptDuration]=useState(15);
  const [editorRestored,setEditorRestored]=useState(false);
  const [materialGroups,setMaterialGroups]=useState<Record<CommerceTab,Material[]>>({home:[],image:[],video:[],agent:[],canvas:[],assets:[]});
  const materials=materialGroups[tab];
  const setMaterialsFor=useCallback((kind:CommerceTab,value:Material[]|((previous:Material[])=>Material[]))=>{let next=typeof value==='function'?value(materialRef.current[kind]):value;if(kind==='image'&&!referenceRecovery.current.get('image')){try{next=orderImageEditorMaterials(next,imageSlotOrder());commitImageDocument(reconcileImageReferenceDocument(imageDocumentRef.current,imageEditorReferences(next),imageSlotOrder()));}catch(error){showNotice((error as Error).message);return;}}const groups={...materialRef.current,[kind]:next};materialRef.current=groups;setMaterialGroups(groups);},[]);
  const setMaterials=(value:Material[]|((previous:Material[])=>Material[]))=>setMaterialsFor(tab,value);
  const materialRef = useRef(materialGroups);materialRef.current=materialGroups;
  const referenceRecovery=useRef(new ReferenceRecoveryState<Draft>());
  const [,setRecoveryRevision]=useState(0);
  const refreshRecovery=()=>setRecoveryRevision(value=>value+1);
  const currentTab=useRef<CommerceTab>('home');
  const [aspectRatios, setAspectRatios] = useState<Record<string,string>>({image:'自适应',video:'9:16',agent:'1:1'});
  const [resolutions, setResolutions] = useState<Record<string, string>>({ image: '1K', video: '720P', agent: '1K' });
  const [format, setFormat] = useState('PNG');
  const [duration, setDuration] = useState(10);
  const [videoGenerateAudio,setVideoGenerateAudio]=useState(true);
  const [assistApplication,setAssistApplication]=useState<AssistApplication|null>(null);
  const [directorApplication,setDirectorApplication]=useState<DirectorApplication|null>(null);
  const [assistApplying,setAssistApplying]=useState(false);
  const assistApplyLock=useRef(false);
  const assistRestorePending=useRef(false);
  const [models, setModels] = useState<Record<string, Model[]>>({ image: [], video: [], agent: [] });
  const [modelsLoading, setModelsLoading] = useState<Record<string, boolean>>({ image: true, video: true, agent: true });
  const [modelIds, setModelIds] = useState<Record<string, string>>({});
  const [modelCatalogs,setModelCatalogs]=useState<Record<ModelKind,ModelCatalogState>>({image:emptyCatalogState(),video:emptyCatalogState(),agent:emptyCatalogState()});
  const [previewTab, setPreviewTab] = useState('预览');
  const [showImageExample,setShowImageExample]=useState(true);
  const [queueOpen, setQueueOpen] = useState(true);
  const [drafts, setDrafts] = useState<Draft[]>(() => readDrafts(ownerKey));
  const [selectedDraft, setSelectedDraft] = useState<string>('');
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scenarioId, setScenarioId] = useState('ecommerce');
  const [planConfirmed, setPlanConfirmed] = useState(false);
  const [product, setProduct] = useState({ name: '', audience: '', sellingPoints: '', specifications: '', language: '简体中文' });
  const [panels, setPanels] = useState<string[]>([...DETAIL_PANELS]);
  const [detailTemplate, setDetailTemplate] = useState(0);
  const [assetFilter, setAssetFilter] = useState('全部');
  const [assetSearch, setAssetSearch] = useState('');
  const [library, setLibrary] = useState<Array<StoredMaterial & { url: string }>>([]);
  const libraryRef = useRef<Array<StoredMaterial & { url: string }>>([]);
  const libraryInput = useRef<HTMLInputElement>(null);
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => readStringArray(`${ownerKey}:favorites`));

  const [selectedTemplate, setSelectedTemplate] = useState<typeof SCENARIOS[number] | null>(null);
  const [utility, setUtility] = useState('');
  const [detailOpen,setDetailOpen]=useState(false);
  const detailOpenRef=useRef(false);
  const detailBeforeLeave=useRef<(()=>Promise<boolean>)|null>(null);
  const registerDetailLeave=useCallback((save:(()=>Promise<boolean>)|null)=>{detailBeforeLeave.current=save;},[]);
  const [depthOpen,setDepthOpen]=useState(false);
  const [depthSessionId,setDepthSessionId]=useState('');
  const [hotRemixOpen,setHotRemixOpen]=useState(false);
  const [voiceOpen,setVoiceOpen]=useState(false);
  const depthOpenRef=useRef(false);
  const depthBeforeLeave=useRef<(()=>Promise<boolean>)|null>(null);
  const registerDepthLeave=useCallback((save:(()=>Promise<boolean>)|null)=>{depthBeforeLeave.current=save;},[]);
  const navigationSequence=useRef(0);
  const workspacePath=useRef(COMMERCE_BASE_PATH);
  const [utilityAssetId,setUtilityAssetId]=useState('');
  const [utilityRange, setUtilityRange] = useState({ start: 0, end: 10 });
  const materialInput = useRef<HTMLInputElement>(null);
  const [pickerSlot,setPickerSlot]=useState<MaterialSlot|null>(null);
  const inputSlot = useRef<MaterialSlot>({ id: 'reference', label: '参考素材', min: 0, max: 9, kinds: ['image', 'video', 'audio'] });
  const [mentionOpen, setMentionOpen] = useState(false);
  const selectedSkill = IMAGE_SKILLS.find(item => item.id === skillId) || IMAGE_SKILLS[0];
  const scenario = SCENARIOS.find(item => item.id === scenarioId) || SCENARIOS[2];
  const directorCardsBase=directorCards.length?directorCards:DIRECTORS;
  const directorSpec=directorCardsBase.find(d=>d.key===director||d.name===director)||directorCardsBase.find(d=>d.default)!;
  const imageSpec=observedImage(selectedSkill.name);
  const mediaKind = tab === 'video' ? 'video' : tab === 'agent' ? 'agent' : 'image';
  const aspectRatio=aspectRatios[mediaKind];
  const setAspectRatio=(value:string)=>setAspectRatios(current=>({...current,[mediaKind]:value}));
  const resolution = resolutions[mediaKind];
  const setResolution = (value: string) => setResolutions(current => ({ ...current, [mediaKind]: value }));
  const model = models[mediaKind].find(item => modelSelectionId(item) === modelIds[mediaKind] || item.id === modelIds[mediaKind]);
  const slots:MaterialSlot[] = tab === 'video' ? model?.capabilities.showLastFrame ? [{id:'first-frame',label:'首帧图片',min:1,max:1,kinds:['image']},{id:'last-frame',label:'尾帧图片',min:1,max:1,kinds:['image']}] : VIDEO_SLOTS : selectedSkill.slots;
  const currentDraft = drafts.find(item => item.id === selectedDraft && item.kind === mediaKind);
  const showNotice = useCallback((message: string) => { setNotice(message); if (noticeTimer.current) clearTimeout(noticeTimer.current); noticeTimer.current = setTimeout(() => setNotice(''), 5500); }, []);

  const runtime = useRuntime(showNotice);
  const [selectedJobId,setSelectedJobId]=useState('editing');
  const [conversationId,setConversationId]=useState('');
  const [helperConversationId,setHelperConversationId]=useState('');
  const [helperMode,setHelperMode]=useState(false);
  const [helperPrompt,setHelperPrompt]=useState('');const [scriptSourceJobId,setScriptSourceJobId]=useState('');
  const directorReferenceLimits:SelectionLimits|undefined=helperMode&&tab==='video'?{total:DIRECTOR_REFERENCE_LIMIT,byKind:{image:directorSpec.slots.filter(slot=>slot.kinds.includes('image')).reduce((sum,slot)=>sum+slot.max,0),video:directorSpec.slots.filter(slot=>slot.kinds.includes('video')).reduce((sum,slot)=>sum+slot.max,0),audio:directorSpec.slots.filter(slot=>slot.kinds.includes('audio')).reduce((sum,slot)=>sum+slot.max,0)}}:undefined;
  const genericVideoReferenceLimits:SelectionLimits={total:15,byKind:{image:12,video:12,audio:3}};
  const videoReferenceLimits:SelectionLimits|undefined=tab==='video'?(directorReferenceLimits||genericVideoReferenceLimits):undefined;
  const videoMaterialSnapshot=useRef<Draft['materials']>([]);
  const currentAssistApplication=matchingAssistApplication(assistApplication,prompts.video,tab==='video'?materials:videoMaterialSnapshot.current,{aspectRatio:aspectRatios.video,resolution:resolutions.video,duration,generateAudio:videoGenerateAudio});
  const currentDirectorApplication=matchingDirectorApplication(directorApplication,prompts.video,tab==='video'?materials:videoMaterialSnapshot.current,{aspectRatio:aspectRatios.video,resolution:resolutions.video,duration,generateAudio:videoGenerateAudio});
  const boundVideoApplication=currentAssistApplication||currentDirectorApplication;
  const videoCapabilities=models.video.find(value=>modelSelectionId(value)===modelIds.video||value.id===modelIds.video)?.capabilities;
  const videoAudioToggleSupported=Boolean(videoCapabilities&&commerceVideoSupportsAudioToggle(videoCapabilities));
  const selectedVideoImageCount=materialGroups.video.filter(item=>item.type.startsWith('image/')).length;
  const selectedVideoAudioCount=materialGroups.video.filter(item=>item.type.startsWith('audio/')).length;
  const selectedVideoSourceCount=materialGroups.video.filter(item=>item.type.startsWith('video/')).length;
  let videoDurationPlan:ReturnType<typeof resolveCommerceVideoDurationPlan>|null=null,videoDurationIssue='';
  if(videoCapabilities)try{videoDurationPlan=resolveCommerceVideoDurationPlan(videoCapabilities,duration,{minimum:4,maximum:COMMERCE_VIDEO_MAX_TOTAL_DURATION});}catch(error){videoDurationIssue=error instanceof Error?error.message:'当前模型不支持该视频时长';}
  const rollingDurationSupported=Boolean(videoDurationPlan&&!videoDurationPlan.native);
  const rollingImageReserve=rollingDurationSupported?1:0;
  const videoImageCapabilityIssue=videoCapabilities&&(videoCapabilities.requiresImage&&!selectedVideoImageCount?'当前模型需要参考图片，请先添加图片。':selectedVideoImageCount<Number(videoCapabilities.minReferenceImages??0)||videoCapabilities.requiresLastFrame&&selectedVideoImageCount<2?'当前模型需要完整的首尾帧或更多参考图片。':selectedVideoImageCount+rollingImageReserve>Number(videoCapabilities.maxReferenceImages??1)?rollingImageReserve?'当前图片数量未给滚动生成尾帧预留位置，请减少图片或更换模型。':'当前图片数量超出所选模型能力，请减少图片或更换模型。':'');
  const videoAudioCapabilityIssue=selectedVideoAudioCount&&videoCapabilities&&(!videoCapabilities.supportsAudioInput||selectedVideoAudioCount>Number(videoCapabilities.maxReferenceAudios??0))?'当前模型不支持这些声音参考，请更换支持音频输入的模型或移除声音素材。':'';
  const videoSourceCapabilityIssue=videoCapabilities&&(videoCapabilities.requiresSourceVideo&&!selectedVideoSourceCount?'当前模型需要源视频，请改用“复刻原视频”上传参考原片。':selectedVideoSourceCount&&(!videoCapabilities.supportsSourceVideoInput||selectedVideoSourceCount>Number(videoCapabilities.maxReferenceVideos??1))?'当前模型不支持这些视频参考，请改用“复刻原视频”或更换支持源视频的模型。':'');
  const videoCatalogReasons=[...new Set(models.video.flatMap(item=>[...(item.selectionIncompatibleReasons||[]),...(item.modeIncompatibleReasons||[])]).filter(Boolean))];
  const videoSelectionIssue=tab==='video'&&!modelsLoading.video&&!model
    ?models.video.length?`当前素材与视频设置没有兼容模型${videoCatalogReasons.length?`：${videoCatalogReasons.slice(0,3).join('；')}`:'；请调整素材、画幅、清晰度或时长。'}`:'当前没有可配置的视频模型。'
    :'';
  let applicationCapabilityIssue='';
  if(tab==='video'){
    applicationCapabilityIssue=videoSelectionIssue||videoImageCapabilityIssue||videoAudioCapabilityIssue||videoSourceCapabilityIssue||videoDurationIssue||'';
    if(!applicationCapabilityIssue&&boundVideoApplication&&videoCapabilities){
      if(videoDurationIssue)applicationCapabilityIssue=`当前模型不支持脚本的 ${duration} 秒时长，请更换模型或重新修改脚本。`;
      else if(Array.isArray(videoCapabilities.aspectRatios)&&videoCapabilities.aspectRatios.length&&!videoCapabilities.aspectRatios.includes(aspectRatios.video))applicationCapabilityIssue='当前模型不支持已应用脚本的画幅，请更换模型或修改设置。';
      else if(Array.isArray(videoCapabilities.resolutionOptions)&&videoCapabilities.resolutionOptions.length&&!videoCapabilities.resolutionOptions.some(value=>String(value).toLowerCase()===resolutions.video.toLowerCase()))applicationCapabilityIssue='当前模型不支持已应用脚本的清晰度，请更换模型或修改设置。';
    }
  }
  const selectedImageCount=materialGroups.image.filter(item=>item.type.startsWith('image/')).length;
  const selectedImageModel=models.image.find(item=>modelSelectionId(item)===modelIds.image||item.id===modelIds.image);
  const selectedImageMax=Number(selectedImageModel?.capabilities.maxReferenceImages??0);
  const imageModelCapabilityIssue=tab==='image'&&!modelsLoading.image?(!selectedImageModel?'请选择一个图片模型。':selectedImageModel.selectionCompatible===false||selectedImageModel.modeCompatible===false?[...(selectedImageModel.selectionIncompatibleReasons||[]),...(selectedImageModel.modeIncompatibleReasons||[])].filter(Boolean).join('；')||'当前模型与参考图数量或图片设置不兼容。':selectedImageCount>0&&selectedImageModel.capabilities.supportsImageInput!==true&&selectedImageModel.capabilities.supportsReferenceInput!==true?'当前模型只支持文字生图；请移除参考图或更换支持参考图的模型。':selectedImageMax>0&&selectedImageCount>selectedImageMax?`当前模型最多支持 ${selectedImageMax} 张参考图，已选择 ${selectedImageCount} 张。`:''):'';
  const imageExecutionIssue=tab==='image'?(modelCatalogs.image.error||(!modelCatalogs.image.configurationReady?modelCatalogs.image.configurationMessage||'图片模型配置尚未发布，暂不可执行。':selectedImageModel?.generationReady!==true?selectedImageModel?.readinessMessage||'当前图片模型生成验收中，暂不可执行。':'')):'';
  function imageSlotOrder(){return getImageInputContract(imageSkillRef.current).slots.map(slot=>slot.id);}
  function imageEditingReferences(){return imageEditorReferences(referenceRecovery.current.get('image')?.snapshot.materials||materialRef.current.image);}
  function commitImageDocument(document:ImageReferenceDocument){imageDocumentRef.current=document;setImageDocument(document);const next={...promptValues.current,image:document.text};promptValues.current=next;setPromptValues(next);}
  function prepareImageSnapshot(snapshot:Draft){if(snapshot.kind!=='image')return snapshot;const slots=getImageInputContract(snapshot.skillId).slots.map(slot=>slot.id),materials=orderImageEditorMaterials(snapshot.materials,slots),document=restoreImageEditorDocument(snapshot.prompt,snapshot.imageReferenceDocument,materials,slots);return {...snapshot,materials,prompt:document.text,imageReferenceDocument:document};}
  function editorSnapshot(kind:RecoveryKind):Draft{return {id:drafts.some(item=>item.id===selectedDraft&&item.kind===kind)?selectedDraft:crypto.randomUUID(),title:kind==='image'?selectedSkill.name:kind==='video'?'视频创作':'Agent',kind,prompt:prompts[kind],skillId:kind==='image'?skillId:'default',createdAt:Date.now(),modelId:modelIds[kind]||'',...(kind==='image'?{imageReferenceDocument:imageDocumentRef.current}:{}),aspectRatio:aspectRatios[kind]||'1:1',resolution:resolutions[kind]||'1K',format,duration,materials:materialRef.current[kind].map(({id,serverId,name,type,slot})=>({id,serverId,name,type,slot})),...(kind==='video'?{director,scriptSourceJobId,assistApplication:assistApplication||undefined,directorApplication:directorApplication||undefined,helperConversationId,helperMode,helperPrompt,scriptLanguage,scriptDuration,generateAudio:videoGenerateAudio}:{}),...(kind==='agent'?{agent:{scenarioId,product:{...product},panels:[...panels],confirmed:planConfirmed}}:{})};}
  function persistEditor(snapshot:Draft,pending=false){
    const value=snapshot.kind==='video'?{mode:snapshot.helperMode?'director':'direct',director:snapshot.director||'default-director',prompt:snapshot.helperPrompt||'',language:snapshot.scriptLanguage||'中文',duration:snapshot.scriptDuration||15,conversationId:snapshot.helperConversationId||'',scriptSourceJobId:snapshot.scriptSourceJobId||'',assistApplication:snapshot.assistApplication||null,directorApplication:snapshot.directorApplication||null,videoPrompt:snapshot.prompt,videoMaterials:snapshot.materials,modelId:snapshot.modelId,videoSettings:{aspectRatio:snapshot.aspectRatio,resolution:snapshot.resolution,duration:snapshot.duration,generateAudio:snapshot.generateAudio!==false},pendingRecovery:pending}:snapshot.kind==='image'?{prompt:snapshot.prompt,skillId:snapshot.skillId,aspectRatio:snapshot.aspectRatio,resolution:snapshot.resolution,format:snapshot.format,modelId:snapshot.modelId,materials:snapshot.materials,imageReferenceDocument:snapshot.imageReferenceDocument,pendingRecovery:pending}:{...snapshot,modelId:snapshot.modelId};
    localStorage.setItem(ownerKey+':'+snapshot.kind+'-editor-state',JSON.stringify(value));
  }
  function replaceEditorMaterials(kind:CommerceTab,next:Material[]){const old=materialRef.current[kind];materialRef.current={...materialRef.current,[kind]:next};setMaterialsFor(kind,next);old.filter(value=>value.url.startsWith('blob:')&&!next.some(item=>item.url===value.url)).forEach(value=>URL.revokeObjectURL(value.url));}
  function applyEditorSnapshot(snapshot:Draft){
    if(snapshot.kind==='image'){imageSkillRef.current=snapshot.skillId;if(snapshot.imageReferenceDocument)commitImageDocument(snapshot.imageReferenceDocument);}
    setPrompts(current=>({...current,[snapshot.kind]:snapshot.prompt}));setModelIds(current=>({...current,[snapshot.kind]:snapshot.modelId||''}));setAspectRatios(current=>({...current,[snapshot.kind]:snapshot.aspectRatio}));setResolutions(current=>({...current,[snapshot.kind]:snapshot.resolution}));
    if(snapshot.kind==='image'){setSkillId(snapshot.skillId);setFormat(snapshot.format==='JPG'?'JPEG':snapshot.format);}
    if(snapshot.kind==='video'){setDuration(snapshot.duration);setDirector(snapshot.director||'default-director');setAssistApplication(snapshot.assistApplication||null);setDirectorApplication(snapshot.directorApplication||null);setHelperPrompt(snapshot.helperPrompt||'');setScriptLanguage(snapshot.scriptLanguage||'中文');setScriptDuration(snapshot.scriptDuration||15);setVideoGenerateAudio(snapshot.generateAudio!==false);setScriptSourceJobId(snapshot.scriptSourceJobId||'');setHelperMode(snapshot.helperMode===true);setHelperConversationId(snapshot.helperConversationId||crypto.randomUUID());videoMaterialSnapshot.current=snapshot.materials;}
    if(snapshot.kind==='agent'&&snapshot.agent){setScenarioId(snapshot.agent.scenarioId);setProduct(snapshot.agent.product);setPanels(snapshot.agent.panels);setPlanConfirmed(snapshot.agent.confirmed);}
  }
  function completeEditorRecovery(attempt:RecoveryAttempt<Draft>,restored:Material[]){
    if(!referenceRecovery.current.active(attempt)){restored.filter(value=>value.url.startsWith('blob:')).forEach(value=>URL.revokeObjectURL(value.url));return;}
    const snapshot={...attempt.snapshot,materials:restored.map(({id,serverId,name,type,slot})=>({id,serverId,name,type,slot}))};
    persistEditor(snapshot);referenceRecovery.current.finish(attempt);replaceEditorMaterials(attempt.kind,restored);if(attempt.kind==='video'){videoMaterialSnapshot.current=snapshot.materials;assistRestorePending.current=false;}refreshRecovery();
  }
  async function resolveEditorRecovery(attempt:RecoveryAttempt<Draft>){
    try{const result=await recoverMaterials(attempt.snapshot.materials,attempt.controller.signal);if(!referenceRecovery.current.active(attempt)){result.materials.filter(value=>value.url.startsWith('blob:')).forEach(value=>URL.revokeObjectURL(value.url));return;}if(result.missing.length){result.materials.filter(value=>value.url.startsWith('blob:')).forEach(value=>URL.revokeObjectURL(value.url));throw Error('以下参考素材不可用：'+result.missing.join('、'));}completeEditorRecovery(attempt,result.materials);}
    catch(error){if(referenceRecovery.current.fail(attempt,(error as Error).message||'素材读取失败')){refreshRecovery();showNotice('参考素材尚未恢复，请重试或明确舍弃后继续。');}}
  }
  function startEditorRecovery(snapshot:Draft){
    try{snapshot=prepareImageSnapshot(snapshot);const attempt=referenceRecovery.current.begin(snapshot,value=>persistEditor(value,true));if(snapshot.kind==='video')assistRestorePending.current=true;applyEditorSnapshot(snapshot);replaceEditorMaterials(snapshot.kind,[]);refreshRecovery();if(snapshot.materials.length)void resolveEditorRecovery(attempt);else completeEditorRecovery(attempt,[]);return true;}
    catch(error){showNotice('恢复内容未能保存：'+(error as Error).message);return false;}
  }
  function retryEditorRecovery(kind:RecoveryKind){const attempt=referenceRecovery.current.get(kind);if(!attempt||attempt.status==='loading')return;try{const next=referenceRecovery.current.begin(attempt.snapshot,value=>persistEditor(value,true));refreshRecovery();void resolveEditorRecovery(next);}catch(error){showNotice('重试内容未能保存：'+(error as Error).message);}}
  function discardEditorRecovery(kind:RecoveryKind){const attempt=referenceRecovery.current.get(kind);if(!attempt)return;try{const snapshot={...attempt.snapshot,materials:[],...(kind==='video'?{assistApplication:undefined,directorApplication:undefined,scriptSourceJobId:''}:{})};persistEditor(snapshot);referenceRecovery.current.cancel(kind);replaceEditorMaterials(kind,[]);if(kind==='video'){videoMaterialSnapshot.current=[];assistRestorePending.current=false;setAssistApplication(null);setDirectorApplication(null);setScriptSourceJobId('');}refreshRecovery();showNotice('已舍弃待恢复素材，创作要求与参数保留。');}catch(error){showNotice('舍弃操作未能保存：'+(error as Error).message);}}
  function blockPendingReferences(kind:CommerceTab=tab){if(!['image','video','agent'].includes(kind)||!referenceRecovery.current.get(kind as RecoveryKind))return false;showNotice('参考素材尚未恢复，请先重试、舍弃待恢复素材或新建创作。');return true;}
  function newEditor(){const kind=mediaKind as RecoveryKind;const snapshot={...editorSnapshot(kind),prompt:'',materials:[],...(kind==='image'?{imageReferenceDocument:createImageReferenceDocument('',[],imageSlotOrder())}:{}),scriptSourceJobId:'',assistApplication:undefined,directorApplication:undefined,helperPrompt:'',helperConversationId:crypto.randomUUID()};if(!startEditorRecovery(snapshot))return;setSelectedDraft('');setSelectedJobId('editing');setPreviewTab('预览');setShowImageExample(true);}
  useEffect(()=>{if(editorRestored&&tab==='video'&&!assistRestorePending.current&&!assistApplying&&directorApplication&&!currentDirectorApplication){setDirectorApplication(null);setScriptSourceJobId('');showNotice('创作内容已修改，已解除原编导脚本版本绑定。');}},[editorRestored,tab,assistApplying,directorApplication,currentDirectorApplication,showNotice]);
  useEffect(()=>{if(editorRestored&&tab==='video'&&!assistRestorePending.current&&!assistApplying&&assistApplication&&!currentAssistApplication){setAssistApplication(null);setScriptSourceJobId('');showNotice('创作要求、素材或参数已修改，已解除原脚本版本绑定。');}},[editorRestored,tab,assistApplying,assistApplication,currentAssistApplication,showNotice]);
  async function applyAssistScript(text:string,jobId:string,application?:AssistApplication){
    if(assistApplyLock.current)return;assistApplyLock.current=true;setAssistApplying(true);try{
      if(application){const {materials:restored,missing}=await recoverMaterials(application.references.map(ref=>({id:crypto.randomUUID(),serverId:ref.id,slot:ref.slot,name:ref.id,type:''})));
        if(missing.length)throw Error('脚本引用素材不可用，请在向导中重新核对：'+missing.join('、'));
        clearMaterials();setMaterials(restored);videoMaterialSnapshot.current=restored;
        setAspectRatios(current=>({...current,video:application.videoSettings.aspectRatio}));setResolutions(current=>({...current,video:application.videoSettings.resolution}));setDuration(application.videoSettings.duration);setVideoGenerateAudio(application.videoSettings.generateAudio);
      }
      setPrompts(current=>({...current,video:text}));setScriptSourceJobId(jobId);setAssistApplication(application||null);setDirectorApplication(null);setHelperMode(false);setAssistId('');setSelectedJobId('editing');setPreviewTab('预览');void runtime.refresh();
    }catch(error){showNotice((error as Error).message);}finally{assistApplyLock.current=false;setAssistApplying(false);}
  }
  async function applyDirectorScript(application:DirectorApplication){
    if(assistApplyLock.current)return;assistApplyLock.current=true;setAssistApplying(true);try{
      const {materials:restored,missing}=await recoverMaterials(application.references.map((ref,index)=>{const source=application.sourceReferences[index];return {id:source?.id===ref.id?(source.instanceId||source.id):crypto.randomUUID(),serverId:ref.id,slot:ref.slot,name:ref.id,type:''};}));
      if(missing.length)throw Error('编导素材不可用，请先核对原会话：'+missing.join('、'));
      clearMaterials();setMaterials(restored);videoMaterialSnapshot.current=restored;setPrompts(current=>({...current,video:application.script}));setScriptSourceJobId(application.jobId);setDirectorApplication(application);setAssistApplication(null);setHelperConversationId(application.conversationId);
      setAspectRatios(current=>({...current,video:application.videoSettings.aspectRatio}));setResolutions(current=>({...current,video:application.videoSettings.resolution}));setDuration(application.videoSettings.duration);setVideoGenerateAudio(application.videoSettings.generateAudio);setHelperMode(false);setSelectedJobId('editing');setPreviewTab('预览');void runtime.refresh();
    }catch(error){showNotice((error as Error).message);}finally{assistApplyLock.current=false;setAssistApplying(false);}
  }
  useEffect(()=>{
    const coordinator=new ReferenceRecoveryState<Draft>();referenceRecovery.current=coordinator;
    for(const kind of ['image','video','agent'] as const)try{
      const saved=JSON.parse(localStorage.getItem(ownerKey+':'+kind+'-editor-state')||'null');if(!saved)continue;
      const snapshot=editorSnapshot(kind),refs=kind==='video'?saved.videoMaterials:saved.materials;
      if(!Array.isArray(refs)||refs.length>15||refs.some(ref=>!ref||typeof ref.id!=='string'||typeof ref.name!=='string'||typeof ref.type!=='string'||typeof ref.slot!=='string'||ref.serverId!==undefined&&typeof ref.serverId!=='string'))throw Error('草稿中的素材引用格式不正确，请保留原草稿后重新选择');
      snapshot.materials=refs;if(kind==='image')snapshot.imageReferenceDocument=saved.imageReferenceDocument;snapshot.prompt=String(kind==='video'?saved.videoPrompt||'':saved.prompt||'');snapshot.modelId=typeof saved.modelId==='string'?saved.modelId:'';
      if(kind==='video'){const settings=saved.videoSettings||{};snapshot.aspectRatio=typeof settings.aspectRatio==='string'?settings.aspectRatio:snapshot.aspectRatio;snapshot.resolution=typeof settings.resolution==='string'?settings.resolution:snapshot.resolution;snapshot.duration=Number.isFinite(settings.duration)?settings.duration:snapshot.duration;snapshot.generateAudio=settings.generateAudio!==false;snapshot.director=String(saved.director||'default-director');snapshot.helperMode=saved.mode==='director';snapshot.helperPrompt=String(saved.prompt||'');snapshot.scriptLanguage=String(saved.language||'中文');snapshot.scriptDuration=Number(saved.duration)||15;snapshot.helperConversationId=String(saved.conversationId||crypto.randomUUID());snapshot.scriptSourceJobId=String(saved.scriptSourceJobId||'');snapshot.assistApplication=saved.assistApplication||undefined;snapshot.directorApplication=saved.directorApplication||undefined;}
      if(kind==='image'){let routeSkill;try{routeSkill=imageRailSkillFromPath(commerceInternalPath(window.location.pathname+window.location.search));}catch{/* Invalid route is reported by applyWorkspacePath; retain the saved draft. */}snapshot.skillId=routeSkill?.localId||(IMAGE_SKILLS.some(value=>value.id===saved.skillId)?saved.skillId:'default');snapshot.format=['PNG','JPEG','JPG','WEBP'].includes(saved.format)?saved.format:'PNG';snapshot.aspectRatio=typeof saved.aspectRatio==='string'?saved.aspectRatio:snapshot.aspectRatio;snapshot.resolution=typeof saved.resolution==='string'?saved.resolution:snapshot.resolution;}
      if(kind==='agent'&&saved.agent)snapshot.agent=saved.agent;
      startEditorRecovery(snapshot);
    }catch(error){showNotice('编辑草稿恢复失败：'+(error as Error).message);}
    setEditorRestored(true);setImageEditorRestored(true);return()=>coordinator.dispose();
  },[ownerKey]);
  useEffect(()=>{if(!editorRestored)return;const snapshot=editorSnapshot('video'),pending=referenceRecovery.current.get('video');if(pending){snapshot.materials=pending.snapshot.materials;referenceRecovery.current.update('video',snapshot);}videoMaterialSnapshot.current=snapshot.materials;try{persistEditor(snapshot,!!pending);}catch{showNotice('视频草稿暂时无法自动保存，请检查浏览器存储空间。');}},[materialGroups.video,tab,aspectRatios.video,resolutions.video,duration,videoGenerateAudio,assistApplication,directorApplication,prompts.video,scriptSourceJobId,editorRestored,helperMode,director,helperPrompt,scriptLanguage,scriptDuration,helperConversationId,modelIds.video,ownerKey,showNotice]);
  const [imageEditorRestored,setImageEditorRestored]=useState(false);
  useEffect(()=>{if(!imageEditorRestored)return;const snapshot=editorSnapshot('image'),pending=referenceRecovery.current.get('image');if(pending){snapshot.materials=pending.snapshot.materials;referenceRecovery.current.update('image',snapshot);}try{persistEditor(snapshot,!!pending);}catch{showNotice('图片草稿暂时无法自动保存，请检查浏览器存储空间。');}},[imageEditorRestored,tab,prompts.image,imageDocument,skillId,aspectRatios.image,resolutions.image,format,materialGroups.image,modelIds.image,ownerKey,showNotice]);
  useEffect(()=>{if(!editorRestored||tab!=='agent')return;const snapshot=editorSnapshot('agent'),pending=referenceRecovery.current.get('agent');if(pending){snapshot.materials=pending.snapshot.materials;referenceRecovery.current.update('agent',snapshot);}try{persistEditor(snapshot,!!pending);}catch{showNotice('Agent 草稿暂时无法自动保存，请检查浏览器存储空间。');}},[editorRestored,tab,prompts.agent,materialGroups.agent,modelIds.agent,scenarioId,product,panels,planConfirmed,ownerKey,showNotice]);
  function chooseDirector(key:string){if(blockPendingReferences('video'))return;const spec=directorCards.find(d=>d.key===key||d.name===key)||directorCards.find(d=>d.default)!;if(spec.key===directorSpec.key){if(currentDirectorApplication)setMaterials(current=>current.map((material,index)=>{const source=currentDirectorApplication.sourceReferences[index];return source&&source.id===(material.serverId||material.id)?{...material,id:source.instanceId||source.id,slot:source.slot}:material;}));setHelperMode(true);setDirectorOpen(false);setSettingsOpen(false);setModelOpen(false);return;}setAssistApplication(null);setDirectorApplication(null);setScriptSourceJobId('');setDirector(spec.key);setModelIds(current=>({...current,agent:''}));setHelperMode(true);setDirectorOpen(false);setSettingsOpen(false);setModelOpen(false);setHelperPrompt('');setHelperConversationId(crypto.randomUUID());setMaterials(current=>current.map(m=>({...m,slot:spec.slots.find(s=>s.kinds.includes(fileKind(m.type)))?.key||m.slot})));}
  function exitDirector(){setScriptSourceJobId('');setHelperMode(false);setDirector('default-director');setMaterials(current=>current.map(m=>({...m,slot:m.type.startsWith('audio/')?'sound':'reference'})));}
  const relevantJobs=runtime.jobs.filter(j=>j.input.kind===mediaKind&&(previewTab!=='收藏'||favoriteIds.includes('job:'+j.id)));
  const selectedJob=selectedJobId==='editing'?undefined:relevantJobs.find(j=>j.id===selectedJobId);
  function toggleJobFavorite(id:string){setFavoriteIds(current=>{const key='job:'+id;const next=current.includes(key)?current.filter(x=>x!==key):[...current,key];localStorage.setItem(ownerKey+':favorites',JSON.stringify(next));return next;});}
  useEffect(()=>{setConversationId(current=>current||crypto.randomUUID());setHelperConversationId(current=>current||crypto.randomUUID());},[conversationId,helperConversationId]);
  useEffect(()=>{const sync=async()=>{const path=window.location.pathname+window.location.search,oldPath=workspacePath.current,attempt=++navigationSequence.current;const leave=depthOpenRef.current?depthBeforeLeave.current:detailOpenRef.current?detailBeforeLeave.current:null;try{if(leave&&oldPath!==path&&!await leave()){if(attempt===navigationSequence.current)window.history.pushState(null,'',oldPath);return;}if(attempt===navigationSequence.current)applyWorkspacePath(path);}catch(error){if(attempt===navigationSequence.current){window.history.pushState(null,'',oldPath);showNotice('当前内容尚未保存：'+(error as Error).message);}}};void sync();window.addEventListener('popstate',sync);return()=>window.removeEventListener('popstate',sync);},[]);
  useEffect(()=>{if(!model||(tab==='video'&&(assistApplication||directorApplication)))return;const caps=model.capabilities;const resolvedResolutions=tab==='video'?commerceVideoResolutionOptions(caps).options:Array.isArray(caps.resolutionOptions)?caps.resolutionOptions.map(String):[];const ratios=caps.aspectRatios;if(resolvedResolutions.length&&!resolvedResolutions.some(value=>value.toLowerCase()===resolution.toLowerCase()))setResolution(String(caps.defaultResolution||resolvedResolutions[0]));if(!(mediaKind==='image'&&['auto','自适应'].includes(aspectRatio))&&Array.isArray(ratios)&&ratios.length&&!ratios.includes(aspectRatio))setAspectRatio(String(ratios[0]));if(tab==='video'){const targets=commerceVideoTargetDurations(caps,{minimum:4,maximum:COMMERCE_VIDEO_MAX_TOTAL_DURATION});if(targets.length&&!targets.some(value=>Math.abs(value-duration)<1e-8))setDuration(targets.reduce((closest,value)=>Math.abs(value-duration)<Math.abs(closest-duration)?value:closest,targets[0]));}},[model?.id,tab]);
  async function references(){
    if(blockPendingReferences())throw Error('请先完成参考素材恢复');const target=tab,kind=mediaKind as RecoveryKind,epoch=referenceRecovery.current.epoch(kind);
    const originalReferences=JSON.stringify(materials.map(({id,slot})=>({id,slot})));const stillCurrent=()=>currentTab.current===target&&referenceRecovery.current.epoch(kind)===epoch&&!referenceRecovery.current.get(kind)&&JSON.stringify(materialRef.current[target].map(({id,slot})=>({id,slot})))===originalReferences;
    const result=[];for(const item of materials){if(!stillCurrent())throw Error('创作内容已切换，本次未提交生成');let serverId=item.serverId;if(!serverId&&item.url.startsWith('/api/commerce/assets/'))serverId=item.id;if(!serverId){const blob=await(await fetch(item.url)).blob();if(!stillCurrent())throw Error('创作内容已切换，本次未提交生成');const asset=await runtime.upload(new File([blob],item.name,{type:item.type}));if(!stillCurrent())throw Error('创作内容已切换，本次未提交生成');serverId=asset.id;if(target==='image'){const completed=completeImageReferenceUpload(imageDocumentRef.current,imageEditorReferences(materialRef.current.image),imageSlotOrder(),{instanceId:item.id,assetId:asset.id});commitImageDocument(completed.document);}setMaterialsFor(target,current=>current.map(m=>m.id===item.id?{...m,serverId:asset.id}:m));}result.push({id:serverId,slot:item.slot,...(target==='image'?{instanceId:item.id}:{})});}if(!stillCurrent())throw Error('创作内容已切换，本次未提交生成');return result;
  }
  const promptCaptureSignature=useRef('');promptCaptureSignature.current=JSON.stringify({tab,prompt,skillId,format,aspectRatios,resolutions,duration,videoGenerateAudio,references:materials.map(({id,slot,name,type})=>({id,slot,name,type})),mentions:imageDocument.mentions.map(({start,end,instanceId,slot})=>({start,end,instanceId,slot}))});
  async function captureUserPrompt(includeReferences:boolean):Promise<UserPromptCapture>{
    const kind=mediaKind as 'image'|'video',target=currentTab.current;if(!['image','video'].includes(target))throw Error('请在图片或视频编辑区保存提示词');
    const signature=promptCaptureSignature.current;const session=await api<{user:{id:string}}>('/api/commerce/session');if(workspaceOwnerKey(session.user.id)!==ownerKey)throw Error('账号已切换，请重新打开提示词窗口');if(promptCaptureSignature.current!==signature)throw Error('编辑内容或参考设置已改变，请重新打开保存窗口');
    const original=promptValues.current[kind],before=materialRef.current[target].map(item=>({...item})),referencesSaved=includeReferences?await references():[];
    if(currentTab.current!==target||promptValues.current[kind]!==original||promptCaptureSignature.current!==signature)throw Error('编辑内容或参考设置已改变，请重新打开保存窗口');
    return {prompt_text:original,context_type:kind,source_type:'editor',capture_signature:signature,metadata_json:{...(kind==='image'?{image_skill_id:skillId,imageReferenceDocument:imageDocumentRef.current,format}:{}),aspect_ratio:aspectRatios[kind],resolution:resolutions[kind],...(kind==='video'?{duration,generate_audio:videoGenerateAudio}:{})},reference_elements_json:referencesSaved.map((ref,index)=>{const source=before.find(item=>item.id===('instanceId' in ref?ref.instanceId:before[index]?.id))||before[index];return {instanceId:source.id,assetId:ref.id,slot:ref.slot,name:source.name,type:source.type};})};
  }
  async function applyUserPrompt(value:Pick<UserPrompt,'title'|'prompt_text'|'context_type'|'metadata_json'|'reference_elements_json'>,signal?:AbortSignal){
    const session=await api<{user:{id:string}}>('/api/commerce/session');if(signal?.aborted)throw Error('已离开案例，草稿尚未应用；可重新打开案例继续。');if(workspaceOwnerKey(session.user.id)!==ownerKey)throw Error('账号已切换，请重新打开提示词或案例');
    if(!['image','video'].includes(value.context_type))throw Error('这条提示词属于画布或Agent，请在对应创作位置使用。');
    const kind=value.context_type as 'image'|'video',meta=value.metadata_json,snapshot=editorSnapshot(kind);
    if(kind==='image'&&IMAGE_SKILLS.find(s=>s.id===meta.image_skill_id)?.canvasOnly)throw Error('这项图片技能需要连接画布来源，请在画布中使用。');
    Object.assign(snapshot,{id:crypto.randomUUID(),title:value.title,prompt:value.prompt_text,skillId:kind==='image'?meta.image_skill_id||'default':'default',materials:value.reference_elements_json.map(r=>({id:r.instanceId,serverId:r.assetId,slot:r.slot,name:r.name,type:r.type})),aspectRatio:meta.aspect_ratio||snapshot.aspectRatio,resolution:meta.resolution||snapshot.resolution,format:meta.format||snapshot.format,duration:meta.duration||snapshot.duration,generateAudio:meta.generate_audio??snapshot.generateAudio,imageReferenceDocument:meta.imageReferenceDocument,helperMode:false,helperPrompt:'',helperConversationId:crypto.randomUUID(),director:'default-director',scriptSourceJobId:'',assistApplication:undefined,directorApplication:undefined});
    if(!startEditorRecovery(snapshot))throw Error('提示词未能恢复，原条目仍保留在我的提示词中');setSelectedDraft('');setSelectedJobId('editing');await navigate(kind);showNotice('提示词已应用；参考素材和设置已带入，请核对后生成。');
  }
  async function openPromptAssist(){try{const data=await api<{session:{id:string}}>('/api/commerce/prompt-assist',{action:'open',contextId:helperConversationId,references:await references(),videoSettings:{resolution:resolutions.video,duration,aspectRatio:aspectRatios.video,generateAudio:videoGenerateAudio}});setAssistId(data.session.id);}catch(e){showNotice((e as Error).message);}}
  async function generate(){
    if(blockPendingReferences())return;if(assistApplying||applicationCapabilityIssue){if(applicationCapabilityIssue)showNotice(applicationCapabilityIssue);return;}
    try{
      if(tab==='image'){
        if(imageModelCapabilityIssue)throw Error(imageModelCapabilityIssue);
        if(imageExecutionIssue)throw Error(imageExecutionIssue);
        if(!modelIds.image)throw Error('请选择一个图片模型后再生成。');
      }
      if(tab==='video'){
        if(!model||!modelIds.video)throw Error(videoSelectionIssue||'请选择一个与当前素材和视频设置兼容的模型。');
        if(model.selectionCompatible===false||model.modeCompatible===false)throw Error([...(model.selectionIncompatibleReasons||[]),...(model.modeIncompatibleReasons||[])].filter(Boolean).join('；')||'当前视频模型与素材或设置不兼容。');
        if(model.generationReady!==true)throw Error(model.readinessMessage||'当前视频模型生成验收中，暂不可执行。');
      }
      const startingText=prompt;
      if(tab==='image'){validateImageInput({skillId,prompt,format,references:materials.map(m=>({id:m.serverId||m.id,slot:m.slot}))},materials.map(m=>({id:m.serverId||m.id,type:m.type})));validateImageReferenceDocument(imageDocumentRef.current,prompt,imageEditingReferences(),imageSlotOrder(),{allowUnresolved:true});if(imageDocumentRef.current.mentions.some(value=>['missing','unassigned'].includes(value.status))||imageLegacyFilenameMentions(prompt,imageEditingReferences()).length)throw Error('图片引用尚未明确，请先修复标出的引用');}
      const refs=await references();let imageReferenceDocument:ImageReferenceDocument|undefined;
      if(tab==='image'){if(imageDocumentRef.current.text!==startingText)throw Error('上传期间图片正文已改变，请核对后重新提交');imageReferenceDocument=validateImageReferenceDocument(imageDocumentRef.current,startingText,imageEditingReferences(),imageSlotOrder());}
      const value=await runtime.submit({kind:mediaKind as 'image'|'video',modelId:modelIds[mediaKind],prompt:startingText,skillId:tab==='image'?skillId:undefined,aspectRatio,resolution,format:tab==='image'?format:undefined,imageReferenceDocument,duration,generateAudio:tab==='video'&&videoAudioToggleSupported?videoGenerateAudio:undefined,assistApplicationId:tab==='video'?currentAssistApplication?.id:undefined,directorApplicationId:tab==='video'?currentDirectorApplication?.id:undefined,parentJobId:tab==='video'&&scriptSourceJobId?scriptSourceJobId:undefined,references:refs});setSelectedJobId(value.id);setPreviewTab('预览');setShowImageExample(false);showNotice('任务已提交，结果会保存到主站资产库。');
    }catch(error){showNotice((error as Error).message);}
  }
  async function sendChat(helper=false){try{const selected=models.agent.find(item=>modelSelectionId(item)===modelIds.agent||item.id===modelIds.agent);if(!selected||!modelIds.agent)throw Error('请选择 Claude Sonnet 4.6 或 GPT-5.6-Sol。');if(!modelCatalogs.agent.configurationReady||selected.generationReady!==true)throw Error(selected.readinessMessage||modelCatalogs.agent.configurationMessage||'对话模型待验收，暂不可执行。');const content=helper?helperPrompt:prompt;const value=await runtime.submit({kind:'agent',modelId:modelIds.agent,prompt:content,conversationId:helper?helperConversationId:conversationId,purpose:helper?'director':'agent',director:helper?director:undefined,spokenLanguage:helper?scriptLanguage:undefined,scriptDuration:helper?scriptDuration:undefined,references:await references()});if(helper)setHelperPrompt('');else setPrompt('');setSelectedJobId(value.id);}catch(e){showNotice((e as Error).message);}}
  async function reuseJob(value:UIJob){
    const kind=value.input.kind as RecoveryKind,snapshot=editorSnapshot(kind),input=value.input;
    snapshot.prompt=input.prompt;snapshot.modelId=input.modelId||'';snapshot.skillId=input.skillId||'default';snapshot.aspectRatio=input.requestedAspectRatio||input.aspectRatio||snapshot.aspectRatio;snapshot.resolution=input.resolution||snapshot.resolution;snapshot.duration=input.duration||snapshot.duration;
    if(kind==='image'){const saved=String(input.format||'PNG').toUpperCase();snapshot.format=saved==='JPG'?'JPEG':['PNG','JPEG','WEBP'].includes(saved)?saved:'PNG';}
    if(kind==='video'){snapshot.assistApplication=undefined;snapshot.directorApplication=undefined;snapshot.generateAudio=input.generateAudio!==false;snapshot.scriptSourceJobId=input.parentJobId||'';snapshot.helperMode=false;snapshot.director='default-director';snapshot.helperPrompt='';snapshot.helperConversationId=crypto.randomUUID();}
    snapshot.materials=(input.references||[]).map(ref=>({id:kind==='image'?ref.instanceId||crypto.randomUUID():crypto.randomUUID(),serverId:ref.id,name:ref.id,type:'',slot:ref.slot}));if(kind==='image')snapshot.imageReferenceDocument=input.imageReferenceDocument;
    if(startEditorRecovery(snapshot)){setSelectedDraft('');void navigate(kind);}
  }
  function useAsset(asset:UIAsset){const kind=asset.type.startsWith('image/')?'image':'video';if(blockPendingReferences(kind))return;setMaterialsFor(kind,current=>[...current.filter(m=>m.serverId!==asset.id),{...asset,id:crypto.randomUUID(),slot:asset.type.startsWith('audio/')?'sound':'reference',serverId:asset.id}]);navigate(kind);}
  function useChat(text:string,kind:'image'|'video'|'canvas'){if(kind==='video'){setScriptSourceJobId('');setHelperConversationId(crypto.randomUUID());}if(kind==='canvas'){localStorage.setItem(ownerKey+':canvas-brief',text);setDetailTemplate(v=>v+1);navigate('canvas');}else{setPrompts(current=>({...current,[kind]:text}));navigate(kind);}setHelperMode(false);}
  const selectedAgentModel=models.agent.find(item=>modelSelectionId(item)===modelIds.agent||item.id===modelIds.agent);
  const agentExecutionIssue=modelCatalogs.agent.error||(!modelCatalogs.agent.configurationReady?modelCatalogs.agent.configurationMessage||'对话模型配置尚未发布，暂不可执行。':selectedAgentModel?.generationReady!==true?selectedAgentModel?.readinessMessage||'当前对话模型待验收，暂不可执行。':'');
  const agentReadinessText=modelsLoading.agent?'正在读取模型…':!selectedAgentModel?'暂无可选择模型':agentExecutionIssue?`可选择配置 · ${agentExecutionIssue} · 暂不可执行`:'主站配置已启用，可执行';
  const chatModelSelect=<div className="ca-chat-model-control" data-testid="commerce-agent-model-picker">{modelOpen&&<div className="ca-model-popover-host" data-testid="commerce-agent-model-list"><ModelPopover items={pickerModels(models.agent,'agent')} selected={modelIds.agent} onSelect={id=>setModelIds(current=>({...current,agent:id}))} onClose={()=>setModelOpen(false)}/></div>}<button type="button" className="ca-model-select" data-popover-trigger data-testid="commerce-agent-model-trigger" aria-label="选择对话模型" aria-expanded={modelOpen} disabled={!modelsLoading.agent&&!models.agent.length} onClick={()=>{setModelOpen(value=>!value);setSettingsOpen(false);}}><Sparkles size={16}/><span>对话模型<strong>{selectedAgentModel?.displayName||(modelsLoading.agent?'正在读取…':'暂不可选')}</strong></span><ChevronDown size={13}/></button><small role="status" data-testid="commerce-agent-model-status" className={agentExecutionIssue?'ca-model-status-blocked':'ca-model-status-ready'}>{agentReadinessText}</small></div>;
  useEffect(() => { materialRef.current = materialGroups; }, [materialGroups]);
  useEffect(() => () => { Object.values(materialRef.current).flat().forEach(item => URL.revokeObjectURL(item.url)); if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);
  useEffect(() => {
    let active = true;
    let loading = false;
    async function load() {
      if(loading)return;loading=true;
      const endpoints:Record<ModelKind,string> = {
        video:videoModelCatalogUrl({referenceImages:selectedVideoImageCount,sourceVideos:selectedVideoSourceCount,referenceAudios:selectedVideoAudioCount,duration,aspectRatio:aspectRatios.video,resolution:resolutions.video,requireAudioToggle:true}),
        image:`/api/commerce/models?kind=image&operationId=${encodeURIComponent(`image.${skillId||'default'}`)}&referenceImages=${selectedImageCount}`,
        agent:'/api/commerce/models?kind=agent&operationId=agent.chat',
      };
      await Promise.allSettled(Object.entries(endpoints).map(async ([kind, url]) => {
        const modelKind=kind as ModelKind;
        try {
          const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
          if (!response.ok) throw Error(modelKind);
          const data = await response.json();
          const values: Model[] = (Array.isArray(data.models) ? data.models : []).filter((item: Model) => item && typeof item.id === 'string' && typeof item.displayName === 'string' && item.capabilities && typeof item.capabilities === 'object');
          if (!active) return;
          setModels(current => ({ ...current, [modelKind]: values }));
          setModelIds(current => {
            const preferred=String(data.defaultCompatibleModelId||data.defaultModelId||'');
            const preferredModel=values.find(item=>item.id===preferred||modelSelectionId(item)===preferred);
            const preferredSelection=preferredModel?modelSelectionId(preferredModel):preferred;
            const next=modelKind==='video'?availableModelId(values.map(item=>({...item,id:modelSelectionId(item)})),current[modelKind],preferredSelection):configuredModelId(values,current[modelKind],preferredSelection);
            return {...current,[modelKind]:next};
          });
          setModelCatalogs(current=>({...current,[modelKind]:{configurationReady:data.configurationReady===true,configurationMessage:String(data.configurationMessage||''),userSelectable:data.userSelectable!==false,generationReadyCount:Number(data.generationReadyCount)||0,error:'',curatedProfiles:Array.isArray(data.curatedProfiles)?data.curatedProfiles:[]}}));
        } catch {
          if(active)setModelCatalogs(current=>({...current,[modelKind]:{...current[modelKind],configurationReady:false,error:`${modelKind==='image'?'图片':modelKind==='agent'?'对话':'视频'}模型目录暂时无法读取，暂不可执行。`}}));
        }
        finally { if (active) setModelsLoading(current => ({ ...current, [modelKind]: false })); }
      }));
      loading=false;
    }
    void load(); const timer=setInterval(()=>void load(),30000); return () => { active = false; clearInterval(timer); };
  }, [skillId,selectedImageCount,selectedVideoImageCount,selectedVideoSourceCount,selectedVideoAudioCount,duration,aspectRatios.video,resolutions.video]);
  const loadLibrary = useCallback(async () => {
    try { const rows = await listMaterials(); libraryRef.current.forEach(item => URL.revokeObjectURL(item.url)); const next = rows.sort((a, b) => b.createdAt - a.createdAt).map(item => ({ ...item, url: URL.createObjectURL(item.blob) })); libraryRef.current = next; setLibrary(next); }
    catch { showNotice('素材库暂时无法读取，请检查浏览器存储权限。'); }
  }, [showNotice]);
  useEffect(() => { void loadLibrary(); return () => libraryRef.current.forEach(item => URL.revokeObjectURL(item.url)); }, [loadLibrary]);
  function applyImageRailPath(path:string){
    const selected=imageRailSkillFromPath(path);if(!selected||selected.localId===imageSkillRef.current)return;
    const skill=IMAGE_SKILLS.find(value=>value.id===selected.localId&&!value.canvasOnly);if(!skill)throw Error('此图片技能尚不可用，请从 AI 图片页面重新选择');
    // Preserve complete references while a prior recovery is loading/failed. begin() cancels its epoch.
    const pending=referenceRecovery.current.get('image'),snapshot={...(pending?.snapshot||editorSnapshot('image')),skillId:skill.id};
    if(!pending){snapshot.prompt=promptValues.current.image;snapshot.imageReferenceDocument=imageDocumentRef.current;}
    if(!startEditorRecovery(snapshot))throw Error('图片技能与草稿尚未保存，仍停留在原入口');
    setSelectedDraft('');setSelectedJobId('editing');
  }
  function applyWorkspacePath(path:string){
    const internalPath=commerceInternalPath(path);
    applyImageRailPath(internalPath);
    const url=new URL(internalPath,window.location.origin),routes:Record<string,CommerceTab>={'/agent-chat':'agent','/toolbox/video-generation':'video','/toolbox/image-generation':'image','/canvas':'canvas','/assets':'assets'};
    workspacePath.current=commerceBrowserPath(internalPath);
    const tools:Record<string,string>={'/toolbox/video-watermark-remove':'水印擦除','/toolbox/video-subtitle-erase':'字幕擦除','/toolbox/video-quality-enhance':'画质增强','/toolbox/video-face-mosaic':'人脸打码','/toolbox/video-editor':'剪辑台'};
    const nextDepth=url.pathname==='/toolbox/depth-video-clone',nextDetail=url.pathname==='/toolbox/ecommerce-image-set',nextHotRemix=url.pathname==='/toolbox/hot-video-remix',nextVoice=url.pathname==='/toolbox/voice-synthesis',nextUtility=tools[url.pathname]||'';
    const next=nextDepth||nextUtility?'video':nextDetail?'image':routes[url.pathname]||'home';
    const previous=currentTab.current;if(previous!==next&&['image','video','agent'].includes(previous)&&referenceRecovery.current.pause(previous as RecoveryKind))refreshRecovery();currentTab.current=next;
    depthOpenRef.current=nextDepth;detailOpenRef.current=nextDetail;setDepthOpen(nextDepth);setDetailOpen(nextDetail);setHotRemixOpen(nextHotRemix);setVoiceOpen(nextVoice);setDepthSessionId(nextDepth?url.searchParams.get('session')||'':'');setUtility(nextUtility);setUtilityAssetId(nextUtility?url.searchParams.get('assetId')||'':'');setTab(next);
    if(next!=='canvas')setDetailTemplate(0);setModelOpen(false);setDirectorOpen(false);setEditorExpanded(false);setSkillOpen(false);setSettingsOpen(false);setMentionOpen(false);
    if(next==='image'){setShowImageExample(true);setPreviewTab('预览');}
  }
  async function guardedNavigation(commit:()=>void){const attempt=++navigationSequence.current;const leave=depthOpenRef.current?depthBeforeLeave.current:detailOpenRef.current?detailBeforeLeave.current:null;try{if(leave&&!await leave())return false;if(attempt!==navigationSequence.current)return false;commit();return true;}catch(error){showNotice('当前内容尚未保存：'+(error as Error).message);return false;}}
  function navigatePath(path:string){const browserPath=commerceBrowserPath(path);return guardedNavigation(()=>{applyWorkspacePath(path);if(window.location.pathname+window.location.search!==browserPath)window.history.pushState(null,'',browserPath);});}
  function navigate(next: CommerceTab) { const routes={home:'/',agent:'/agent-chat',video:'/toolbox/video-generation',image:'/toolbox/image-generation',canvas:'/canvas',assets:'/assets'};return navigatePath(routes[next]); }
  function openSkill(skill: CommerceSkill) { if(blockPendingReferences('image'))return;setSkillOpen(false);imageSkillRef.current=skill.id;setSkillId(skill.id);setMaterialsFor('image',materialRef.current.image);setShowImageExample(true);navigate('image');setSelectedDraft(''); }
  function chooseScenario(id: string) {
    if(id==='detail'||id==='replicate'){void navigatePath(id==='detail'?'/toolbox/ecommerce-image-set':'/toolbox/depth-video-clone').then(saved=>{if(saved)setSelectedTemplate(null);});return;}
    const value = SCENARIOS.find(item => item.id === id) || SCENARIOS[2];
    setScenarioId(value.id); setPrompts(current => ({ ...current, agent: value.prompt })); setPlanConfirmed(false); navigate('agent'); setSelectedTemplate(null);
  }
  function clearMaterials(kind:CommerceTab=tab) { if(['image','video','agent'].includes(kind)){referenceRecovery.current.cancel(kind as RecoveryKind);if(kind==='video')assistRestorePending.current=false;refreshRecovery();}replaceEditorMaterials(kind,[]); }
  function openUpload(slot: MaterialSlot) { if(blockPendingReferences())return;inputSlot.current = slot; setPickerSlot(slot); }
  function usePickedAssets(assets:UIAsset[]){if(!pickerSlot||blockPendingReferences())return;const target:CommerceTab=tab==='assets'?(assets.every(asset=>asset.type.startsWith('image/'))?'image':'video'):tab;if(blockPendingReferences(target))return;const accepted:UIAsset[]=[];const limits=target==='video'?(videoReferenceLimits||genericVideoReferenceLimits):undefined;for(const asset of assets){const issue=selectionError(materialGroups[target],accepted,asset,pickerSlot,limits);if(issue){showNotice(issue);return;}accepted.push(asset);}setMaterialsFor(target,current=>[...current,...accepted.map(asset=>({id:crypto.randomUUID(),serverId:asset.id,name:asset.name,type:asset.type,size:asset.size,url:asset.url,slot:pickerSlot.id}))]);setPickerSlot(null);if(tab==='assets')navigate(accepted.every(asset=>asset.type.startsWith('image/'))?'image':'video');}
  async function addFiles(files: FileList | File[] | null, slot = inputSlot.current) {
    if (!files||blockPendingReferences()) return;
    const targetTab=tab,epoch=['image','video','agent'].includes(tab)?referenceRecovery.current.epoch(tab as RecoveryKind):0;
    const added: Material[] = [];
    const errors: string[] = [];
    const limits=targetTab==='video'?videoReferenceLimits:undefined;
    for (const file of Array.from(files)) {
      const kind = fileKind(file.type);
      if (!kind || !slot.kinds.includes(kind)) { errors.push(`${file.name} 格式不支持`); continue; }
      const id = crypto.randomUUID();
      const issue=selectionError(materials,added,{id,name:file.name,type:file.type,size:file.size,slot:slot.id},slot,limits);if(issue){errors.push(`${file.name} ${issue}`);continue;}
      try { await saveMaterial({ id, name: file.name, type: file.type, size: file.size, slot: slot.id, createdAt: Date.now(), blob: file }); }
      catch { errors.push(`${file.name} 保存失败，请检查浏览器空间`); continue; }
      added.push({ id, name: file.name, url: URL.createObjectURL(file), type: file.type, size: file.size, slot: slot.id });
    }
    if(currentTab.current!==targetTab||(['image','video','agent'].includes(targetTab)&&referenceRecovery.current.epoch(targetTab as RecoveryKind)!==epoch)){added.forEach(value=>URL.revokeObjectURL(value.url));return;}setMaterialsFor(targetTab,current => [...current, ...added]); await loadLibrary(); if (errors.length) showNotice(errors.join('；'));
  }
  function removeMaterial(id: string) { setMaterials(current => current.filter(item => { if (item.id === id) { URL.revokeObjectURL(item.url); return false; } return true; })); }
  function updateDrafts(next: Draft[]) {
    try { localStorage.setItem(`${ownerKey}:drafts`, JSON.stringify(next)); setDrafts(next); return true; } catch { showNotice('草稿保存失败，请检查浏览器存储空间。'); return false; }
  }
  function saveDraft(kind: Draft['kind'] = mediaKind as Draft['kind']) {
    if (!prompt.trim() && !materials.length && !(kind==='video'&&helperMode) && !(kind === 'agent' && product.name.trim())) { showNotice('请先填写创作要求或添加参考素材。'); return; }
    if(blockPendingReferences(kind))return;
    const title = kind === 'image' ? selectedSkill.name : kind === 'video' ? directorSpec.default ? '视频创作' : directorSpec.name : scenario.name;
    const draft: Draft = { id: crypto.randomUUID(), title, kind, prompt, skillId, createdAt: Date.now(), modelId:modelIds[kind]||'', aspectRatio, resolution, format, duration,...(kind==='image'?{imageReferenceDocument:imageDocumentRef.current}:{}), materials: materials.map(({ id, name, type, slot,serverId }) => ({ id, name, type, slot,serverId })), ...(kind === 'agent' ? { agent: { scenarioId, product: { ...product }, panels: [...panels], confirmed: planConfirmed } } : {}), ...(kind === 'video' ? { director,scriptSourceJobId,assistApplication:currentAssistApplication||undefined,directorApplication:currentDirectorApplication||undefined,helperConversationId,helperMode,helperPrompt,scriptLanguage,scriptDuration,generateAudio:videoGenerateAudio } : {}) };
    if (updateDrafts([draft, ...drafts].slice(0, 80))) { setSelectedDraft(draft.id); showNotice('创作要求与素材引用已保存到带货项目的本浏览器草稿。'); }
  }
  async function restoreDraft(draft:Draft){if(startEditorRecovery(draft)){setSelectedDraft(draft.id);void navigate(draft.kind);}}
  function exportDraft(draft: Draft) { downloadText(`${draft.title}.json`, JSON.stringify({ ...draft, stage: 'draft', generated: false }, null, 2)); }
  function favorite(id: string) { const next = favoriteIds.includes(id) ? favoriteIds.filter(value => value !== id) : [...favoriteIds, id]; try { localStorage.setItem(`${ownerKey}:favorites`, JSON.stringify(next)); setFavoriteIds(next); } catch { showNotice('收藏保存失败。'); } }
  function goTool(index: number) { if (index === 0) void navigate('canvas'); else if (index === 6) openSkill(IMAGE_SKILLS.find(item => item.id === 'image-refine')!); else if(index===7)void guardedNavigation(()=>{window.location.href='/commerce/toolbox/digital-human';});else { const paths:Record<number,string>={1:'/toolbox/video-editor',2:'/toolbox/video-quality-enhance',3:'/toolbox/video-watermark-remove',4:'/toolbox/video-subtitle-erase',5:'/toolbox/video-face-mosaic',8:'/toolbox/hot-video-remix',9:'/toolbox/voice-synthesis'};void navigatePath(paths[index]); } }
  function prepareHome() { if (!prompt.trim() && !materials.length) { showNotice('描述一下你想创作的内容，或先添加参考素材。'); return; } if(homeMode==='video'){setScriptSourceJobId('');setHelperMode(false);setHelperConversationId(crypto.randomUUID());}setPrompts(current => ({ ...current, [homeMode]: current.home }));if(materials.length){clearMaterials(homeMode);setMaterialsFor(homeMode,materials);setMaterialsFor('home',[]);}navigate(homeMode); }
  const renderMaterial = (item: Material) => <div className="ca-material" key={item.id}>{item.type.startsWith('image/') ? <img src={item.url} alt={item.name} /> : item.type.startsWith('video/') ? <Video size={24} /> : <Music size={24} />}<button title={`移除 ${item.name}`} onClick={() => removeMaterial(item.id)}><X size={12} /></button><span title={item.name}>{item.name}</span>{tab==='image'&&<b className="ca-image-reference-number">@图片{imageEditingReferences().findIndex(value=>value.instanceId===item.id)+1}</b>}</div>;
  const inputMaterials = <>{materials.map(renderMaterial)}<button className="ca-attach" title="添加参考素材" onClick={() => openUpload({ id: 'reference', label: '参考素材', min: 0, max: 9, kinds: ['image', 'video', 'audio'] })}><Plus size={25} /></button></>;
  const currentModelStatus=mediaKind==='image'&&imageExecutionIssue?`可选择配置 · ${imageExecutionIssue}`:mediaKind==='video'&&!modelsLoading.video&&!model&&models.video.length?'当前素材或设置没有兼容模型':model?.generationReady===false?`可选择配置 · ${model.readinessMessage||'生成待验收'}`:model?.generationReady===true?'主站配置已启用，可执行':'';
  const modelSelect = <button className="ca-model-select" data-popover-trigger data-testid={`commerce-${mediaKind}-model-trigger`} aria-label={mediaKind==='image'?'选择图片模型':'选择视频模型'} aria-expanded={modelOpen} disabled={!modelsLoading[mediaKind]&&!models[mediaKind].length} onClick={()=>{setModelOpen(!modelOpen);setSettingsOpen(false);}}><Sparkles size={18}/><span>模型<strong>{model?.displayName||(modelsLoading[mediaKind]?'正在读取模型…':'暂无可选择模型')}</strong>{currentModelStatus&&<small>{currentModelStatus}</small>}</span><ChevronDown size={13}/></button>;
  const geminiFlagshipProfile=modelCatalogs.image.curatedProfiles.find(profile=>/gemini\s*3\s*pro|nano\s*banana\s*pro/i.test(`${profile.label} ${profile.id}`));
  const directorMaterials=<>{directorSpec.slots.map(value=>{const slot=slotFromObserved(value);const audioSlot=slot.kinds.includes('audio');return <div className="ca-director-slot" key={slot.id}><div>{materials.filter(m=>m.slot===slot.id).map(renderMaterial)}<button title={'添加'+slot.label} onClick={()=>openUpload(slot)}><img src={value.cover||PUBLIC_UI.upload} alt=""/><Upload size={12} className="ca-director-upload-badge"/></button></div><small>添加{slot.label}{slot.min?'':' (可选)'}{audioSlot?` · 单个≤${DIRECTOR_AUDIO_MAX_SECONDS}秒`:''}</small></div>;})}</>;

  const pendingReferences=['image','video','agent'].includes(tab)?referenceRecovery.current.get(tab as RecoveryKind):undefined;
  const recoveryPanel=pendingReferences&&<div className="ca-muted" role={pendingReferences.status==='loading'?'status':'alert'} aria-label="参考素材恢复"><strong>{pendingReferences.status==='loading'?'正在恢复参考素材':pendingReferences.status==='paused'?'素材恢复已暂停':'参考素材恢复失败'}</strong><p>{pendingReferences.error||`已保留 ${pendingReferences.snapshot.materials.length} 个素材引用，恢复完成后可继续生成。`}</p><div className="ca-actions"><button disabled={pendingReferences.status==='loading'} onClick={()=>retryEditorRecovery(pendingReferences.kind)}>重试恢复素材</button><button onClick={()=>discardEditorRecovery(pendingReferences.kind)}>舍弃待恢复素材</button></div></div>;
  return <div className="commerce-root" data-tab={tab} data-testid="commerce-workspace">
    {pickerSlot&&<AssetPicker runtime={runtime} slot={pickerSlot} existing={materials} limits={tab==='assets'?genericVideoReferenceLimits:videoReferenceLimits} onSelect={usePickedAssets} onClose={()=>setPickerSlot(null)}/>}
    <input ref={materialInput} hidden type="file" onChange={event => { addFiles(event.target.files); event.target.value = ''; }} />
    <aside className="ca-rail" data-workspace-sidebar><div className="ca-brand" title="带货 Agent"><ShoppingBag size={24} /></div><nav aria-label="带货 Agent 导航"><button type="button" title="返回应用广场" onClick={() => { try { markSecondaryPageReturn(); } catch {} window.location.href = '/'; }}><LayoutGrid size={20} /><span>应用广场</span></button>{MENU.map(({ key, name, Icon }) => key==='image'?<ImageRailMenu key={key} active={tab===key&&!utility&&!detailOpen&&!depthOpen&&!hotRemixOpen&&!voiceOpen} routeKey={workspacePath.current} onNavigate={navigatePath} onError={showNotice}><Icon size={20}/><span>{name}</span></ImageRailMenu>:<button key={key} className={tab === key && !utility && !detailOpen && !depthOpen && !hotRemixOpen && !voiceOpen ? 'active' : ''} onClick={() => navigate(key)} aria-current={tab === key && !utility && !detailOpen && !depthOpen && !hotRemixOpen && !voiceOpen ? 'page' : undefined}><Icon size={20} /><span>{name}</span></button>)}</nav><div className="ca-rail-credits" title="生成费用由主站现金钱包统一结算"><Coins size={16}/><span>主站钱包</span></div><div className="ca-rail-bottom"><a className="ca-admin-entry" href="/commerce/help" title="使用教程"><BookOpen size={19} /><span>帮助</span></a></div></aside>
    <div className="ca-content">{announceShow&&<div className="ca-announce" role="note"><span className="ca-announce-tag">新功能</span><span>滚动生成支持最长 {COMMERCE_VIDEO_MAX_TOTAL_DURATION} 秒 · 人脸打码 · 资产分组 · 爆款拆解反哺成片全链路</span><button aria-label="关闭公告" onClick={()=>{setAnnounceShow(false);try{localStorage.setItem('ca-announce-20260912','1');}catch{}}}>×</button></div>}
      {tab === 'home' && !hotRemixOpen && !voiceOpen && <div className="ca-home">
        <div className="ca-announcement ca-announce-rel"><Megaphone size={15} /><strong>带货 Agent</strong><span>从商品参考到图片、详情页与视频，组织你的创作流程</span><button onClick={() => navigate('agent')}>进入创作 <ChevronRight size={13} /></button></div>
        <a className="ca-home-help" href="/commerce/help"><BookOpen size={14} />使用教程</a>
        <div className="ca-hero-glow" />
        <section className="ca-hero"><div className="ca-hero-composer"><div className="ca-home-input"><div className="ca-hero-materials">{inputMaterials}</div><textarea aria-label="首页创作要求" placeholder="结合参考，输入文字或 @ 主体，说说今天想做什么。" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={10000} /></div><div className="ca-composer-bottom"><label><Sparkles size={17} /><select aria-label="创作模式" value={homeMode} onChange={event => setHomeMode(event.target.value as typeof homeMode)}><option value="agent">Agent 模式</option><option value="image">图片模式</option><option value="video">视频模式</option></select></label><button className="ca-send" title="开始创作" onClick={prepareHome}><ArrowUp size={21} /></button></div></div></section>
        <section className="ca-quick-tools" aria-label="快捷工具">{TOOL_ITEMS.map((name, index) => { const Icon = TOOL_ICONS[index]; return <button key={name} onClick={() => goTool(index)}><span><Icon size={20} /></span>{name}</button>; })}</section>
        <section className="ca-scenarios"><div className="ca-section-head"><div><h2>你想做什么？ <small>选择创作目标快速开始</small></h2></div></div><div className="ca-scenario-strip">{SCENARIOS.map((item, index) => { const Icon = SCENARIO_ICONS[index]; return <button className={`ca-scenario ca-scenario-${item.id}`} key={item.id} onClick={() => chooseScenario(item.id)}><div className="ca-scenario-image"><img src={item.image} alt={`${item.name}模板示意`} loading="lazy" /><span className="ca-image-corner">模板示意</span>{index !== 1 && <span className="ca-play"><Play size={13} fill="currentColor" /></span>}</div><div><strong><Icon size={15} />{item.name}</strong><span>{item.description}</span></div></button>; })}</div></section>
        <DiscoveryGallery ownerKey={ownerKey} onApply={applyUserPrompt} onNavigateCanvas={id=>navigatePath('/canvas?canvasId='+encodeURIComponent(id))} onNotice={showNotice}/>
      </div>}

      {assistId&&<PromptAssist id={assistId} runtime={runtime} onClose={()=>{if(!assistApplying)setAssistId('');}} onApply={(text,jobId,application)=>void applyAssistScript(text,jobId,application)}/>}
      {(tab === 'image' || tab === 'video') && !utility && !detailOpen && !depthOpen && <div className={`ca-studio ${!queueOpen ? 'ca-studio-noqueue' : ''} ${editorExpanded?'ca-editor-expanded':''}`} data-kind={tab} data-mode={helperMode&&tab==='video'?'director':'direct'}>
        <section className="ca-editor"><div className="ca-editor-heading"><button data-popover-trigger onClick={() => tab === 'image' ? setSkillOpen(true) : setDirectorOpen(true)}><span className="ca-tool-avatar"><img src={tab === 'image' ? imageSpec?.icon||'/commerce/image-icon.png' : helperMode?directorSpec.icon||'/commerce/video-icon.png':'/commerce/video-icon.png'} alt=""/></span><span><strong>{tab === 'image' ? selectedSkill.name : directorSpec.default ? '视频创作' : directorSpec.name}</strong>{(tab==='image'&&skillId!=='default'||tab==='video'&&helperMode)&&<small>{tab==='image'?selectedSkill.description:directorSpec.description}</small>}</span><ChevronRight size={17} /></button>{tab==='video'&&helperMode&&<button title="保存当前编导草稿" onClick={()=>saveDraft('video')}><Save size={15}/></button>}<button className="ca-new" onClick={newEditor}>＋ 新建</button></div>
          {recoveryPanel}
          {tab==='video'&&<button type="button" className="ca-depth-entry" aria-label="上传原视频并替换人物、服装、商品或环境" onClick={()=>void navigatePath('/toolbox/depth-video-clone')}><Video size={18}/><span><strong>复刻原视频</strong><small>上传原视频，选择模型，再替换人物/服装、商品、环境或声音</small></span><ChevronRight size={16}/></button>}
          {skillOpen&&tab==='image'&&<CreationPicker kind="image" onClose={()=>setSkillOpen(false)} items={IMAGE_SKILLS.filter(i=>i.id!=='default'&&!i.canvasOnly).map(i=>({id:i.id,name:i.name,description:observedImage(i.name)?.description||i.description,...(()=>{const p=observedImage(i.name);return {category:p?.category||i.category,icon:p?.icon,recommended:p?.recommended,order:p?.order};})()}))} onPick={id=>openSkill(IMAGE_SKILLS.find(i=>i.id===id)!)}/>}
          {directorOpen&&tab==='video'&&<CreationPicker kind="video" onClose={()=>setDirectorOpen(false)} items={directorCards.filter(d=>!d.default).map((d,i)=>({id:d.key,...d,order:i}))} onPick={chooseDirector}/>}
          {helperMode&&tab==='video'?<DirectorPanel runtime={runtime} directorName={directorSpec.key} directorSpec={directorSpec} getReferences={async()=>{const instances=materials.map(item=>item.id);return (await references()).map((ref,index)=>({...ref,instanceId:instances[index]}));}} videoSettings={{aspectRatio:aspectRatios.video,resolution:resolutions.video,duration:scriptDuration,generateAudio:videoGenerateAudio}} setGenerateAudio={setVideoGenerateAudio} onApplied={application=>void applyDirectorScript(application)} conversationId={helperConversationId} prompt={helperPrompt} setPrompt={setHelperPrompt} onSend={()=>void sendChat(true)} onExit={exitDirector} onUse={(text,jobId)=>{setHelperMode(false);setScriptSourceJobId(jobId||'');setPrompt(text);setMaterials(current=>current.map(m=>({...m,slot:m.type.startsWith('audio/')?'sound':'reference'})));const options=models.video.find(m=>modelSelectionId(m)===modelIds.video||m.id===modelIds.video)?.capabilities.nativeDurations;if(Array.isArray(options)&&options.includes(scriptDuration))setDuration(scriptDuration);else if(scriptDuration!==duration)showNotice('脚本已应用；请核对当前视频模型支持的时长。');}} materials={directorMaterials} hasMaterials={materials.length>0} language={scriptLanguage} setLanguage={setScriptLanguage} duration={scriptDuration} setDuration={setScriptDuration}/>:<>
          <div className="ca-prompt-box" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); addFiles(event.dataTransfer.files, slots[0]); }}><div className="ca-input-toolbar"><span>{materials.filter(item => slots.some(slot => slot.id === item.slot)).length} / {tab === 'image' ? getImageInputContract(skillId).mediaMaxCount.image : 15}</span><div><UserPromptLibrary ownerKey={ownerKey} capture={captureUserPrompt} onApply={applyUserPrompt} onNotice={showNotice} toolbarIcons={tab==='image'?{save:<ImageEditorIcon kind="save"/>,library:<ImageEditorIcon kind="library"/>}:undefined}/>{tab!=='image'&&<><button title="素材库" onClick={() => openUpload(slots[0])}><FolderOpen size={14} /></button><button title="引用素材" onClick={() => setMentionOpen(!mentionOpen)}>＠</button></>}<button title={editorExpanded?"收起编辑区":"展开编辑区"} onClick={() => setEditorExpanded(!editorExpanded)}>{tab==='image'?<ImageEditorIcon kind="expand"/>:<Expand size={14} />}</button></div></div>
            <div className="ca-slots">{slots.map(slot => <div key={slot.id} className="ca-slot"><div className="ca-slot-files">{materials.filter(item => item.slot === slot.id).map(renderMaterial)}{materials.filter(item => item.slot === slot.id).length < slot.max && <button className="ca-slot-upload" title={`添加${slot.label}`} onClick={() => openUpload(slot)}><img src={tab==='image'?imageSpec?.slots[slots.indexOf(slot)]?.cover||PUBLIC_UI.upload:slot.id==='sound'?PUBLIC_UI.sound:PUBLIC_UI.upload} alt=""/><Upload size={12} /></button>}</div><span>{tab==='image'?'添加'+(imageSpec?.slots[slots.indexOf(slot)]?.label||'图片')+(slot.min===0?' (可选)':''):(slot.label.startsWith('添加')?slot.label:'添加'+slot.label)+(slot.min>0?'':' (可选)')}</span><small>最多 {slot.max} 个</small></div>)}{tab==='image'&&skillId==='default'&&<button className="ca-add-more-reference" title="点击添加参考图片" onClick={()=>openUpload(slots[0])}><Plus size={24}/><small>点击添加</small></button>}</div>
            {materials.some(item => !slots.some(slot => slot.id === item.slot)) && <div className="ca-unassigned"><span>分配参考素材：</span>{materials.filter(item => !slots.some(slot => slot.id === item.slot)).map(item => <label key={item.id}>{item.name}<select aria-label={`分配${item.name}角色`} value="" onChange={event => { const target = slots.find(slot => slot.id === event.target.value); if (!target) return; if (materials.filter(value => value.slot === target.id).length >= target.max || !target.kinds.includes(fileKind(item.type) as 'image' | 'video' | 'audio')) { showNotice('该角色已满或不支持此素材类型。'); return; } setMaterials(current => current.map(value => value.id === item.id ? { ...value, slot: target.id } : value)); }}><option value="">选择角色</option>{slots.map(slot => <option key={slot.id} value={slot.id}>{slot.label}</option>)}</select></label>)}</div>}
            <ImagePromptLine enabled={tab==='image'} skill={tab==='image'&&skillId!=='default'?<button className="ca-skill-chip" onClick={()=>setSkillOpen(true)}><ImageIcon size={14}/>{selectedSkill.name}</button>:undefined}>
            <textarea ref={tab==='image'?imageTextarea:undefined} onPaste={event=>{if(tab!=='image')return;const text=event.clipboardData.getData('text/plain');if(!text)return;event.preventDefault();try{commitImageDocument(applyImageReferenceTextEdit(imageDocumentRef.current,{start:event.currentTarget.selectionStart,end:event.currentTarget.selectionEnd,text},imageEditingReferences(),imageSlotOrder()));}catch(error){showNotice((error as Error).message);}}} aria-label={tab === 'image' ? '图片创作要求' : '视频创作要求'} value={prompt} onChange={event => { setPrompt(event.target.value); if (event.target.value.endsWith('/')) setSkillOpen(tab === 'image'); if (event.target.value.endsWith('@')) setMentionOpen(true); }} maxLength={tab === 'image' ? 2000 : 10000} placeholder={tab === 'image' ? skillId==='default'?'请输入图片内容；输入 / 选择生成技能，输入 @ 引用上方参考图片。':imageSpec?.hint||selectedSkill.description : '输入视频提示词，使用 @ 指定参考素材，或「帮我写」'} /></ImagePromptLine>
            {tab==='image'?<ImageReferenceControls document={imageDocument} references={imageEditingReferences()} slots={getImageInputContract(skillId).slots} showMenu={mentionOpen} textarea={imageTextarea.current} onChange={commitImageDocument} onClose={()=>setMentionOpen(false)} onError={showNotice}/>:mentionOpen&&<div className="ca-mention-menu"><strong>引用参考素材</strong>{materials.length?materials.map(item=><button key={item.id} onClick={()=>{setPrompt(value=>`${value.replace(/@$/,'')}@${item.name} `);setMentionOpen(false);}}>{item.name}</button>):<p>请先添加参考素材。</p>}<button onClick={()=>setMentionOpen(false)}>收起</button></div>}
            <div className="ca-prompt-bottom">{tab==='image'&&<button className="ca-save-image-draft" title="保存待执行草稿" onClick={()=>saveDraft()}><Save size={12}/>保存草稿</button>}<span>{prompt.length} / {tab === 'image' ? 2000 : 10000}</span>{tab === 'video' && <div className="ca-video-helper-actions"><button onClick={()=>void openPromptAssist()}>帮我写</button><button onClick={() => chooseDirector('default-director')}><Sparkles size={13} />超级编导</button></div>}</div></div>
          <div className="ca-settings-row">{modelOpen&&<div className="ca-model-popover-host" data-testid={`commerce-${mediaKind}-model-list`}><ModelPopover items={pickerModels(models[mediaKind],mediaKind as ModelKind)} selected={modelIds[mediaKind]} onSelect={id=>setModelIds(current=>({...current,[mediaKind]:id}))} onClose={()=>setModelOpen(false)}/></div>}<div className="ca-parameter-anchor" data-testid={`commerce-${mediaKind}-model-picker`}>{modelSelect}</div><div className="ca-parameter-anchor">{settingsOpen&&<MediaSettings kind={tab==='video'?'video':'image'} capabilities={model?.capabilities||{}} modelName={model?.displayName} compatibilityIssue={tab==='video'?applicationCapabilityIssue:undefined} aspectRatio={aspectRatio} resolution={resolution} format={format} duration={duration} generateAudio={videoAudioToggleSupported?videoGenerateAudio:undefined} onGenerateAudio={videoAudioToggleSupported?setVideoGenerateAudio:undefined} onRatio={setAspectRatio} onResolution={setResolution} onFormat={setFormat} onDuration={setDuration} onClose={()=>setSettingsOpen(false)}/>}<button data-popover-trigger data-testid={`commerce-${mediaKind}-settings-trigger`} aria-expanded={settingsOpen} onClick={() => {setSettingsOpen(!settingsOpen);setModelOpen(false);}}><SlidersHorizontal size={18} /><span>{tab === 'image' ? '图片设置' : '视频设置'}<strong>{aspectRatio} · {resolution} · {tab === 'image' ? format : `${duration} 秒 · ${videoAudioToggleSupported?(videoGenerateAudio?'含音频':'静音'):'模型默认音频'}`}</strong></span><ChevronDown size={13} /></button></div></div>
          {modelCatalogs[mediaKind].error&&<p role="alert" className="ca-muted">{modelCatalogs[mediaKind].error}</p>}{tab==='image'&&geminiFlagshipProfile&&geminiFlagshipProfile.status!=='selectable'&&<p role="status" data-testid="commerce-image-gemini-flagship-status" className="ca-model-planned"><strong>Gemini 3 Pro Image（Nano Banana Pro）</strong><span>{geminiFlagshipProfile.statusMessage||'旗舰模型待接入、待验收，当前不进入可选列表。'}</span></p>}{tab==='image'&&imageModelCapabilityIssue&&<p role="alert" data-testid="commerce-image-model-boundary" className="ca-muted">{imageModelCapabilityIssue}</p>}{tab==='image'&&imageExecutionIssue&&<p role="status" data-testid="commerce-image-model-status" className="ca-model-readiness">配置可选，生成待验收：{imageExecutionIssue}</p>}{tab==='video'&&model?.generationReady===false&&<p role="status" className="ca-model-readiness">{model.readinessMessage||'当前模型生成验收中；可先选择和配置，提交时仍会核验。'}</p>}{applicationCapabilityIssue&&<p role="alert" className="ca-muted">{applicationCapabilityIssue}</p>}
          <div className="ca-generate-row"><button className="ca-primary" disabled={!runtime.ready||runtime.sending||assistApplying||!!referenceRecovery.current.get(mediaKind as RecoveryKind)||!!applicationCapabilityIssue||(tab==='image'&&(!model||!canConfigureModel(model)||!!imageModelCapabilityIssue||!!imageExecutionIssue))||(tab==='video'&&(!model||model.capabilities.available===false||model.generationReady===false))} onClick={()=>void generate()}>{runtime.sending?'提交中…':tab === 'image' ? '立即生成图片' : '立即生成视频'}<span>{tab==='image'&&imageExecutionIssue?'配置可选，生成待验收':tab==='video'&&model?.generationReady===false?'完成生成验收后开放':Number(model?.publicPrice)>0?`参考 ¥${(Number(model?.publicPrice)*(model?.capabilities.billingUnit==='output_second'?duration:1)).toFixed(2)} 起`:'生成前确认准确价格'}</span></button>{tab!=='image'&&<button title="保存待执行草稿" onClick={() => saveDraft()}><Save size={18} /></button>}</div></>}
        </section>
        <section className="ca-preview"><div className="ca-tabs">{[tab==='image'?'参考示例':'预览','收藏'].map(label=>{const name=label==='参考示例'?'预览':label;return <button key={name} className={previewTab===name?'selected':''} onClick={()=>{setPreviewTab(name);if(tab==='image')setShowImageExample(true);}}>{label}</button>;})}{!queueOpen&&<button className="ca-open-queue" onClick={()=>setQueueOpen(true)}>任务列表 <ChevronRight size={14}/></button>}</div>{previewTab==='预览'?(tab==='image'&&showImageExample?<ImageExample name={selectedSkill.name}/>:<TaskPreview onNotice={showNotice} favorite={!!selectedJob&&favoriteIds.includes('job:'+selectedJob.id)} onFavorite={()=>selectedJob&&toggleJobFavorite(selectedJob.id)} job={selectedJob} onReuse={reuseJob} onRetry={()=>{if(selectedJob)void api('/api/commerce/jobs',{action:'retry-save',id:selectedJob.id}).then(()=>runtime.refresh()).catch(e=>showNotice(e.message));}}/>):<div className="ca-reference-grid">{SCENARIOS.filter(item=>favoriteIds.includes(item.id)).map(item=><button key={item.id} onClick={()=>setSelectedTemplate(item)}><img src={item.image} alt={item.name}/><span>{item.name}</span></button>)}</div>}</section>
        {queueOpen&&<TaskQueue drafts={drafts.filter(draft=>draft.kind===mediaKind)} onSelectDraft={id=>{const draft=drafts.find(value=>value.id===id);if(draft)void restoreDraft(draft);}} editing={{selected:!selectedJob,onSelect:()=>{setSelectedJobId('editing');setPreviewTab('预览');setShowImageExample(true);}}} jobs={relevantJobs} selected={selectedJob?.id||''} onSelect={id=>{setSelectedJobId(id);setPreviewTab('预览');setShowImageExample(false);}} onClose={()=>setQueueOpen(false)}/>}
      </div>}

      {tab === 'agent' && recoveryPanel}
      {tab === 'agent' && <ChatPanel runtime={runtime} prompt={prompt} setPrompt={setPrompt} modelSelect={chatModelSelect} onSend={()=>void sendChat()} materials={inputMaterials} onNew={()=>{setConversationId(crypto.randomUUID());setPrompt('');clearMaterials();}} conversationId={conversationId} setConversationId={setConversationId} onUse={useChat}/>}

      {tab === 'canvas' && <CommerceCanvas runtime={runtime} ownerKey={ownerKey} detailTemplate={detailTemplate} panelTitles={panels} onNotice={showNotice} />}

      {tab === 'assets' && <div><button className="ca-library-open-manager" onClick={()=>openUpload({id:'reference',label:'参考素材',min:0,max:9,kinds:['image','video','audio']})}>素材选择与文件夹管理</button><ServerAssets runtime={runtime} onUse={useAsset} onNotice={showNotice}/></div>}

      {detailOpen && <DetailSetStudio runtime={runtime} onBeforeLeaveReady={registerDetailLeave} onClose={()=>navigate('home')} onNotice={showNotice}/>}
      {depthOpen && <DepthVideoCloneStudio runtime={runtime} initialSessionId={depthSessionId||undefined} onBeforeLeaveReady={registerDepthLeave} onNotice={showNotice} onBack={()=>void navigate('home')} onOpenEditor={assetId=>void navigatePath('/toolbox/video-editor?assetId='+encodeURIComponent(assetId))}/>}
      {hotRemixOpen && <HotVideoRemixStudio runtime={runtime} onNotice={showNotice} onBack={()=>void navigate('home')}/>}
      {voiceOpen && <VoiceSynthesisStudio onNotice={showNotice} onBack={()=>void navigate('home')}/>}
      {utility && <MediaTools key={utility+':'+utilityAssetId} name={utility} runtime={runtime} initialAssetId={utilityAssetId||undefined} onNotice={showNotice} onBack={()=>navigate('home')}/>}
    </div>

    {selectedTemplate && <Modal title={selectedTemplate.name} onClose={() => setSelectedTemplate(null)}><img className="ca-template-preview" src={selectedTemplate.image} alt={`${selectedTemplate.name}模板示意`} /><p>{selectedTemplate.description}</p><ol className="ca-template-stages">{selectedTemplate.stages.map(stage => <li key={stage}>{stage}</li>)}</ol><p className="ca-muted">这里是创作结构示意，尚未展示本次生成结果。</p><button className="ca-primary" onClick={() => chooseScenario(selectedTemplate.id)}>使用这个创作结构</button></Modal>}
    {notice && <div className="ca-notice" role="status"><Check size={16} /><span>{notice}</span><button title="关闭提示" onClick={() => setNotice('')}><X size={14} /></button></div>}
  </div>;
}

function Modal({ title, children, onClose, variant = 'standard' }: { title: string; children: React.ReactNode; onClose: () => void; variant?: 'standard' | 'skill' | 'settings' }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,button,select,textarea')?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key === 'Tab') { const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,[tabindex="0"]') || [])]; const first = nodes[0], last = nodes[nodes.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
    }
    document.addEventListener('keydown', keydown); return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);
  return <div className={`ca-modal-overlay ca-modal-overlay-${variant}`} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className="ca-modal" ref={ref} role="dialog" aria-modal="true" aria-label={title}><div className="ca-modal-header"><h2>{title}</h2><button onClick={onClose} aria-label="关闭弹窗"><X size={20} /></button></div><div className="ca-modal-content">{children}</div></div></div>;
}
function Empty({ title, text, icon = 'image' }: { title: string; text: string; icon?: string }) { const Icon = icon === 'video' ? Video : icon === 'file' ? FileText : ImageIcon; return <div className="ca-empty"><Icon size={43} strokeWidth={1.3} /><h3>{title}</h3><p>{text}</p></div>; }
function readStringArray(key: string): string[] { try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []; } catch { return []; } }
function readDrafts(key: string): Draft[] { try { const value = JSON.parse(localStorage.getItem(`${key}:drafts`) || '[]'); return Array.isArray(value) ? value.filter(item => typeof item?.id === 'string' && typeof item.title === 'string' && typeof item.prompt === 'string' && ['image', 'video', 'agent'].includes(item.kind) && Array.isArray(item.materials)).slice(0, 80) : []; } catch { return []; } }
function downloadText(name: string, text: string) { const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
