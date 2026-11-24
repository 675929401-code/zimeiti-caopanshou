'use client';
import { toApisStandardNativeSize } from "@/lib/toapis-image-contract";
import {isMemberChatSkill} from '@/commerce/shared/member-chat-skills';
import {workspaceInputs} from '@/commerce/shared/transient-workspace';
import {WorkspaceRoleUpload} from './workspace-role-upload';
import {ChatWorkspaceMenu} from './chat-workspace-menu';
import {ImageEditorIcon} from './image-editor-icons';
import {RailNavigationPanel} from './rail-navigation-panel';
import {ImageRailMenu} from './image-rail-menu';
import {imageRailSkillFromPath} from './image-rail-menu-data';
import {ImagePromptLine} from './image-prompt-line';
import {ReferenceProjectEntry} from './reference-project-entry';

import {PromptAssist} from './prompt-assist';
import {DiscoveryGallery} from './discovery-gallery';
import {AssetPicker} from './asset-picker';
import {ImageReferenceControls} from './image-reference-controls';
import {imageEditorReferences,orderImageEditorMaterials,restoreImageEditorDocument,imageLegacyFilenameMentions,assignSingleImageSlot,assignOpenImageSlots} from './image-reference-editor';
import {createImageReferenceDocument,reconcileImageReferenceDocument,editImageReferenceDocument,applyImageReferenceTextEdit,completeImageReferenceUpload,validateImageReferenceDocument,type ImageReferenceDocument} from '../../shared/image-reference-mentions';
import {selectionError,type SelectionLimits} from './material-selection';
import {recoverMaterials as recoverWorkspaceMaterials,type MaterialReference} from './material-recovery';
import {ReferenceRecoveryState,type RecoveryAttempt,type RecoveryKind} from './reference-recovery-state';
import {DETAIL_QUALITY_OPTIONS,isDetailImageQuality,supportsWorkspaceQuality,type DetailImageQuality} from '../../shared/detail-image-quality';
import {getImageInputContract,validateImageInput} from '../../image-input-contract';
import {WorkspaceIdentity} from './workspace-identity';
import {workspaceOwnerKey} from './workspace-storage';
import {UserPromptLibrary,type UserPromptCapture} from './user-prompt-library';
import type {UserPrompt} from '../../server/user-prompts';
import {MediaTools} from './media-tools';
import {HotVideoRemixStudio} from './hot-video-remix-studio';
import {VoiceSynthesisStudio} from './voice-synthesis-studio';
import {videoPickerProfile,videoFamilyIcons} from '../../shared/video-picker-catalog';
import {availableModelId,videoModelCatalogUrl} from './model-selection';
import {matchingAssistApplication} from './assist-application';
import type {AssistApplication} from '../../server/prompt-assist-schema';
import {DIRECTOR_SCRIPT_DEFAULT,restoreDirectorDuration} from '../../shared/director-parameters';
import {DIRECTOR_MEDIA_LIMITS,DIRECTOR_REFERENCE_LIMIT,matchingDirectorApplication,type DirectorApplication} from '../../server/director-conversation-schema';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { listMaterials as listOwnedMaterials, saveMaterial as saveOwnedMaterial, type StoredMaterial } from './material-store';
import { Video, Image as ImageIcon, ArrowLeft, FolderOpen, Plus, ArrowUp, ChevronDown, ChevronRight, X, Scissors, Sparkles, Eraser, Captions, SlidersHorizontal, Upload, Download, Save, Search, Heart, Play, Check, FileText, ShoppingBag, Megaphone, Clock, RotateCcw, Shirt, UserRound, Package, Music, Expand, Mic } from 'lucide-react';
import { RailAdminLink } from './rail-admin-link';
import { markSecondaryPageReturn } from '@/lib/marketplace-navigation';
import {RailAvatar, RailLogin, RailMore, RailWallet, useMemberCashBalance, useRailAccount} from './rail-account';
import { DIRECTOR_GROUPS, VIDEO_SLOTS, SCENARIOS, DETAIL_PANELS, HOME_QUICK_TOOLS, type CommerceTab, type MaterialSlot, type CommerceSkill } from './catalog';
import { useHomeCatalog } from './use-home-catalog';
import {useRuntime,TaskPreview,TaskQueue,ChatPanel,api,type UIJob,type UIAsset} from './runtime-ui';
import './workspace.css';
import './delivery.css';
import './alignment.css';
import './image-visible-alignment.css';
import './workbench-nav-align.css';
import {MemberAssets} from '@/features/commerce-studio/member-assets';
import {StudioLibrary} from '@/features/commerce-studio/asset-library';
import {StudioHome} from '@/features/commerce-studio/home';
import {StudioScenes,sceneSidebarOrder} from '@/features/commerce-studio/scenes';
import {directorReferenceLayout} from '@/commerce/shared/director-reference-layout';
import {directorScenes,isDirectorScene,sceneCharacterSlot} from '@/commerce/shared/director-scenarios';
import {CharacterCreate} from '@/features/commerce-studio/character-create';
import {manualSceneNeeded,visibleSceneCards} from '@/features/commerce-studio/scene-storyboards';
import {SceneStoryboard} from '@/features/commerce-studio/reversal';
import {SkillDirectory} from '@/features/commerce-studio/skill-directory';
import {builtinSkills,type MemberSkill,type SkillLibrary} from '@/features/commerce-studio/member-skills';
import {AgentPreferencePanel} from '@/features/commerce-studio/agent-preference-panel';
import {defaultAgentPreferences,preferenceBrief,type AgentPreferences,type MediaPreferences,type PreferenceMedia} from '@/features/commerce-studio/agent-preferences';
import {RoleDirectory} from '@/features/commerce-studio/directories';
import {GroupBuyEditor} from '@/features/commerce-studio/group-buy-editor';
import {groupBuyScene,groupBuyDirectorDraft,type StoreProject,type StudioVersion} from '@/features/commerce-studio/group-buy';
import {sceneKeys,imageKeys,groupKeys,scenarioPath,imagePath,videoPath} from '@/features/commerce-studio/routes';
import '@/features/commerce-studio/studio.css';
import {RailHomeIcon,RailAgentIcon,RailVideoIcon,RailImageIcon,RailCanvasIcon,RailFolderIcon} from './rail-icons';
import {AnchoredPanel,CreationPicker,MediaSettings,ModelPopover,DirectorPanel,ImageExample,DIRECTORS,PUBLIC_UI,observedImage,slotFromObserved} from './reference-ui';
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
type Model = { id: string; memberResolutionOptions?:string[]; memberChannelIds?:string[]; agentPreferenceRank?:number; selectionId?: string; displayName: string; publicPrice: number; memberBilling?:import('../../shared/video-picker-catalog').MemberVideoBilling; capabilities: Record<string, unknown>; verified?: boolean; generationReady?: boolean; readinessMessage?: string; configurationSelectable?: boolean; selectionAvailable?: boolean; selectionCompatible?: boolean; selectionIncompatibleReasons?: string[]; modeCompatible?: boolean; modeIncompatibleReasons?: string[]; curatedProfileId?: string; curatedStatus?: string; tier?: number; tierLabel?: string };
type ModelKind = 'image' | 'video' | 'agent';
type CuratedProfile = { id: string; kind: ModelKind; label: string; status: 'selectable' | 'pending' | 'missing'; userVisible: boolean; boundModelId?: string | null; boundModelName?: string | null; statusMessage?: string; role?: string };
type ModelCatalogState = { configurationReady: boolean; configurationMessage: string; userSelectable: boolean; generationReadyCount: number; error: string; curatedProfiles: CuratedProfile[] };
type Material = { serverId?: string; id: string; name: string; url: string; type: string; size: number; slot: string };
type Product = { name: string; audience: string; sellingPoints: string; specifications: string; language: string };
type Draft = { id: string; number?: number; title: string; kind: 'image' | 'video' | 'agent'; prompt: string; skillId: string; createdAt: number; modelId: string; aspectRatio: string; resolution: string; format: string; imageQuality?: DetailImageQuality; duration: number; materials: Array<{ id: string; name: string; type: string; slot: string;serverId?:string }>; imageReferenceDocument?:ImageReferenceDocument; scriptSourceJobId?:string; assistApplication?:AssistApplication; directorApplication?:DirectorApplication; helperConversationId?:string; helperMode?:boolean; helperPrompt?:string; scriptLanguage?:string; scriptDuration?:number; generateAudio?:boolean; director?: string; agent?: { scenarioId: string; product: Product; panels: string[]; confirmed: boolean } };
const MENU = [{ key: 'home', name: '首页', Icon: RailHomeIcon }, { key: 'agent', name: 'Agent', Icon: RailAgentIcon }, { key: 'video', name: 'AI 视频', Icon: RailVideoIcon }, { key: 'image', name: 'AI图片', Icon: RailImageIcon }, { key: 'canvas', name: '画布', Icon: RailCanvasIcon }, { key: 'assets', name: '资产', Icon: RailFolderIcon }] as const;
type SpeechRecognitionLike = { lang: string; interimResults: boolean; continuous: boolean; start: () => void; stop: () => void; onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onerror: (() => void) | null; onend: (() => void) | null };
const DIRECTOR_NAV_STORAGE_KEY = 'ca-director-nav-collapsed';
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
function VideoTriggerIcon({name}:{name?:string}) {
  const profile=name?videoPickerProfile(name):undefined;
  return profile?<img className="ca-video-trigger-brand" src={videoFamilyIcons[profile.family]} alt=""/>:<Sparkles size={18}/>;
}
function pickerModels(items:Model[],kind?:ModelKind){return items.map(item=>{const max=Number(item.capabilities.maxReferenceImages??0),supportsReferences=item.capabilities.supportsImageInput===true||item.capabilities.supportsReferenceInput===true;const configurationHint=kind==='image'?(supportsReferences?max>0?`最多 ${max} 张参考图`:'支持参考图':'仅文字生图，不支持参考图'):undefined;const incompatibleReasons=[...new Set([...(item.modeIncompatibleReasons||[]),...(item.selectionIncompatibleReasons||[])].filter(Boolean))];return {...item,id:modelSelectionId(item),configurationHint,modeCompatible:item.modeCompatible!==false&&item.selectionCompatible!==false,modeIncompatibleReasons:incompatibleReasons,capabilities:{...item.capabilities,available:canConfigureModel(item)}};});}
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
  const roleReturn=useRef(videoPath);
  const [skillView,setSkillView]=useState('');
  const [agentPrefs,setAgentPrefs]=useState<AgentPreferences>(defaultAgentPreferences);
  const [prefsLoaded,setPrefsLoaded]=useState(false),[prefsSaving,setPrefsSaving]=useState(false);
  const preferenceWrite=useRef(false);
  const [agentSkillId,setAgentSkillId]=useState('');
  const agentSkill=builtinSkills.find(skill=>skill.id===agentSkillId);
  const [skillDraft,setSkillDraft]=useState<{id:string;text:string}|null>(null);
  const [canaryJobId,setCanaryJobId]=useState('');
  const [extraView,setExtraView]=useState(''),[studioScene,setStudioScene]=useState(''),[studioGroup,setStudioGroup]=useState(''),[studioProjectId,setStudioProjectId]=useState(''),[studioVersionId,setStudioVersionId]=useState('');
  const [homeNav,setHomeNav]=useState(false);
  const groupLeave=useRef<null|(()=>boolean)>(null);
  const [libraryView,setLibraryView]=useState('materials');
  const [studioMode,setStudioMode]=useState('');
  const groupDirectorKey=tab==='video'&&studioScene===groupBuyScene&&studioProjectId&&studioMode==='director'?studioProjectId+'/'+studioVersionId:'';
  const [groupHandoff,setGroupHandoff]=useState({key:'',error:''});
  const groupBuyOpen=tab==='video'&&studioScene===groupBuyScene&&studioMode!=='director';
  const [directorCards, setDirectorCards] = useState<typeof DIRECTORS>([]);
  const storyboardOpen=tab==='video'&&studioMode==='storyboard'&&isDirectorScene(studioScene);
  const [directorCatalogIssue,setDirectorCatalogIssue]=useState('');
  const [catalogAttempt,setCatalogAttempt]=useState(0);
  const [prompts, setPromptValues] = useState<Record<string, string>>({ home: '', image: '', video: '', agent: '' });
  const homeDocument=useRef<ImageReferenceDocument>({version:1,text:'',mentions:[]});
  const [homeReady,setHomeReady]=useState(false),[homeLoadError,setHomeLoadError]=useState(''),[homeAttempt,setHomeAttempt]=useState(0);
  const homeImages=(items:Material[])=>imageEditorReferences(items.filter(item=>item.type.startsWith('image/')));
  const promptValues=useRef(prompts);promptValues.current=prompts;
  const [imageDocument,setImageDocument]=useState<ImageReferenceDocument>({version:1,text:'',mentions:[]});const imageDocumentRef=useRef(imageDocument);const imageSkillRef=useRef('default');const imageTextarea=useRef<HTMLTextAreaElement>(null);
  const setPrompts=(value:Record<string,string>|((previous:Record<string,string>)=>Record<string,string>))=>{const next=typeof value==='function'?value(promptValues.current):value;if(next.home!==homeDocument.current.text){homeDocument.current=editImageReferenceDocument(homeDocument.current,next.home,homeImages(materialRef.current.home),['reference']);next.home=homeDocument.current.text;}if(next.image!==imageDocumentRef.current.text){const doc=editImageReferenceDocument(imageDocumentRef.current,next.image,imageEditingReferences(),imageSlotOrder());imageDocumentRef.current=doc;setImageDocument(doc);next.image=doc.text;}promptValues.current=next;setPromptValues(next);};
  const promptKey = tab === 'home' ? 'home' : tab === 'video' ? 'video' : tab === 'agent' ? 'agent' : 'image';
  const prompt = prompts[promptKey];
  const imagePromptLimit=5000;
  const setPrompt = (value: string | ((previous: string) => string)) => setPrompts(current => ({ ...current, [promptKey]: typeof value === 'function' ? value(current[promptKey]) : value }));
  const [homeSkill,setHomeSkill]=useState<MemberSkill|null>(null);
  const [homeMode, setHomeMode] = useState<'agent' | 'image' | 'video'>('agent');
  const railAccount = useRailAccount();
  const memberCashBalance = useMemberCashBalance(railAccount);
  const [homeImagePicker,setHomeImagePicker]=useState(false);
  const [directorNavCollapsed, setDirectorNavCollapsed] = useState(false);
  const [createRoleMethod,setCreateRoleMethod]=useState<'image'|'camera'|null>(null);
  const [roleLibraryVersion,setRoleLibraryVersion]=useState(0);
  const [pickerCollection, setPickerCollection] = useState<'assets' | 'roles'>('assets');
  const [listening, setListening] = useState(false);
  const voiceRecognition = useRef<SpeechRecognitionLike | null>(null);
  useEffect(() => { try { setDirectorNavCollapsed((localStorage.getItem(ownerKey+':scene-collapsed')??localStorage.getItem(DIRECTOR_NAV_STORAGE_KEY)) === '1'); } catch {} }, []);
  const [skillId, setSkillId] = useState('default');
  const [skillOpen, setSkillOpen] = useState(false);
  useEffect(()=>{
    let alive=true,loading=false,lastRead=0;
    async function refreshCatalog(){
      if(loading)return;
      loading=true;
      try {
        const data=await api<{directors:typeof DIRECTORS}>('/api/commerce/v1/director-catalog');
        if(!Array.isArray(data.directors))throw Error('编导目录格式无效');
        if(alive){lastRead=Date.now();setDirectorCards(data.directors);setDirectorCatalogIssue(data.directors.length?'':'后台尚未启用编导');}
      } catch {
        if(alive)setDirectorCatalogIssue('编导目录暂时无法更新');
      }finally{loading=false;}
    }
    const onFocus=()=>{if(Date.now()-lastRead>15000)void refreshCatalog();};
    void refreshCatalog();
    window.addEventListener('focus',onFocus);
    return ()=>{alive=false;window.removeEventListener('focus',onFocus);};
  },[catalogAttempt]);
  const [skillSearch, setSkillSearch] = useState('');
  const [directorOpen, setDirectorOpen] = useState(false);
  const [referenceProjectOpen,setReferenceProjectOpen]=useState(false);
  const [assistId,setAssistId]=useState('');
  const [director, setDirector] = useState('default-director');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelOpen,setModelOpen]=useState(false);
  const [editorExpanded,setEditorExpanded]=useState(false);
  const [scriptLanguage,setScriptLanguage]=useState('中文');
  const [scriptDuration,setScriptDuration]=useState<number>(DIRECTOR_SCRIPT_DEFAULT);
  const [editorRestored,setEditorRestored]=useState(false);
  const [materialGroups,setMaterialGroups]=useState<Record<CommerceTab,Material[]>>({home:[],image:[],video:[],agent:[],canvas:[],assets:[]});
  const materials=materialGroups[tab];
  const setMaterialsFor=useCallback((kind:CommerceTab,value:Material[]|((previous:Material[])=>Material[]))=>{let next=typeof value==='function'?value(materialRef.current[kind]):value;if(kind==='home'){const revised=reconcileImageReferenceDocument(homeDocument.current,homeImages(next),['reference']);homeDocument.current=revised;if(revised.text!==promptValues.current.home)setPrompts(v=>({...v,home:revised.text}));}if(kind==='image'&&!referenceRecovery.current.get('image')){try{next=orderImageEditorMaterials(next,imageSlotOrder());commitImageDocument(reconcileImageReferenceDocument(imageDocumentRef.current,imageEditorReferences(next),imageSlotOrder()));}catch(error){showNotice((error as Error).message);return;}}const groups={...materialRef.current,[kind]:next};materialRef.current=groups;setMaterialGroups(groups);},[]);
  const setMaterials=(value:Material[]|((previous:Material[])=>Material[]))=>setMaterialsFor(tab,value);
  const materialRef = useRef(materialGroups);materialRef.current=materialGroups;
  const referenceRecovery=useRef(new ReferenceRecoveryState<Draft>());
  const [,setRecoveryRevision]=useState(0);
  const refreshRecovery=()=>setRecoveryRevision(value=>value+1);
  const currentTab=useRef<CommerceTab>('home');
  const [aspectRatios, setAspectRatios] = useState<Record<string,string>>({image:'自适应',video:'9:16',agent:'1:1'});
  const [resolutions, setResolutions] = useState<Record<string, string>>({ image: '1K', video: '720P', agent: '1K' });
  const [imageQuality,setImageQuality]=useState<DetailImageQuality>();
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
  const videoSkuById=useRef(new Map<string,string>());
  const loadedModelQueries=useRef<Partial<Record<ModelKind,{url:string;at:number}>>>({});
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
  const [minimizedClip,setMinimizedClip]=useState<string|null>(null);
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
  useEffect(() => { if (!pickerSlot) setPickerCollection('assets'); }, [pickerSlot]);
  const inputSlot = useRef<MaterialSlot>({ id: 'reference', label: '参考素材', min: 0, max: 9, kinds: ['image', 'video', 'audio'] });
  const [mentionOpen, setMentionOpen] = useState(false);
  const homeCatalog = useHomeCatalog();
  const imageSkills = homeCatalog.imageSkills;
  const scenarios = homeCatalog.scenarios;
  const selectedSkill = imageSkills.find(item => item.id === skillId) || imageSkills[0];
  const scenario = scenarios.find(item => item.id === scenarioId) || scenarios[2] || SCENARIOS[2];
  const storedScene=director.startsWith('brief:')?director.slice(6):'';
  const sceneTask=isDirectorScene(storedScene)?storedScene:undefined;
  const sceneCard=sceneTask?DIRECTORS.find(d=>d.key===directorScenes[sceneTask].cardKey):undefined;
  const activeDirector=directorCards.find(d=>sceneTask?d.key==='default-director':d.key===director||d.name===director);
  const directorSpec=activeDirector||DIRECTORS.find(d=>d.default)!;
  const {product:productSlot, productMinimum, actor:actorSlot, nativeActor, actorMax}=directorReferenceLayout(directorSpec,sceneTask);
  const directorSlots=actorSlot&&!nativeActor ? directorSpec.slots.flatMap(slot => slot===actorSlot
    ? [slot,{...slot,key:sceneCharacterSlot,label:'角色',min:0,max:actorMax,kinds:['image'],cover:sceneCard?.slots.find(v=>v.label==='角色')?.cover||slot.cover}]
    : [slot]) : directorSpec.slots;
  const missingDirectorImage=!!productSlot&&materials.filter(item=>item.slot===productSlot.key&&item.type.startsWith('image/')).length<productMinimum;
  const imageSpec=observedImage(selectedSkill.name);
  const mediaKind = tab === 'video' ? 'video' : tab === 'agent' ? 'agent' : 'image';
  const aspectRatio=aspectRatios[mediaKind];
  const setAspectRatio=(value:string)=>setAspectRatios(current=>({...current,[mediaKind]:value}));
  const resolution = resolutions[mediaKind];
  const setResolution = (value: string) => setResolutions(current => ({ ...current, [mediaKind]: value }));
  const model = models[mediaKind].find(item => modelSelectionId(item) === modelIds[mediaKind] || item.id === modelIds[mediaKind]);
  const qualityCaps=model?.capabilities||{};
  const effectiveImageQuality=supportsWorkspaceQuality(qualityCaps,imageQuality)?imageQuality:supportsWorkspaceQuality(qualityCaps,qualityCaps.detailDefaultQuality)?qualityCaps.detailDefaultQuality:undefined;
  const imageQualityLabel=DETAIL_QUALITY_OPTIONS.find(o=>o.value===effectiveImageQuality)?.label;
  // 应用或退出编导后仍按场景槽位展示（对齐对标站）；素材状态保持 reference/sound 以维持脚本绑定校验。
  const directorSceneActive=Boolean(sceneCard||!directorSpec.default);
  const directorMaterialSlots:MaterialSlot[]=directorSlots.map(slot=>({id:slot.key,label:slot.label,min:slot.min,max:slot.max,kinds:slot.kinds as MaterialSlot['kinds']}));
  const slots:MaterialSlot[] = tab === 'video' ? model?.capabilities.showLastFrame ? [{id:'first-frame',label:'首帧图片',min:1,max:1,kinds:['image']},{id:'last-frame',label:'尾帧图片',min:1,max:1,kinds:['image']}] : directorSceneActive ? directorMaterialSlots : VIDEO_SLOTS : selectedSkill.slots;
  const showNotice = useCallback((message: string) => { setNotice(message); if (noticeTimer.current) clearTimeout(noticeTimer.current); noticeTimer.current = setTimeout(() => setNotice(''), 5500); }, []);

  const runtime = useRuntime(showNotice);
  useEffect(()=>{
    const controller=new AbortController();
    async function restoreHome(){
      try{
        const raw=workspaceInputs.get(ownerKey+':studio-home');
        if(raw){
          const draft=JSON.parse(raw) as {document:ImageReferenceDocument;materials:MaterialReference[];mode:typeof homeMode;skill?:MemberSkill};
          if(draft.document?.version!==1||!Array.isArray(draft.materials))throw Error('首页草稿格式无效');
          const result=await recoverMaterials(draft.materials,controller.signal);
          if(controller.signal.aborted){result.materials.filter(m=>m.url.startsWith('blob:')).forEach(m=>URL.revokeObjectURL(m.url));return;}
          homeDocument.current=draft.document;
          setMaterialsFor('home',result.materials);
          setPrompts(v=>({...v,home:homeDocument.current.text}));
          if(draft.skill&&typeof draft.skill.id==='string'&&typeof draft.skill.name==='string')setHomeSkill(draft.skill);
          if(['agent','video','image'].includes(draft.mode))setHomeMode(draft.mode);
          if(result.missing.length)showNotice('以下素材需重新选择：'+result.missing.join('、'));
        }
        setHomeLoadError('');setHomeReady(true);
      }catch(error){if(!controller.signal.aborted)setHomeLoadError((error as Error).message);}
    }
    void restoreHome();return()=>controller.abort();
  },[ownerKey,homeAttempt]);
  useEffect(()=>{
    if(!homeReady)return;
    try{workspaceInputs.set(ownerKey+':studio-home',JSON.stringify({mode:homeMode,skill:homeSkill,document:homeDocument.current,materials:materialGroups.home.map(({id,serverId,slot,name,type})=>({id,serverId,slot,name,type}))}));}
    catch{showNotice('首页草稿保存失败，请检查浏览器存储空间');}
  },[homeReady,homeMode,homeSkill,prompts.home,materialGroups.home,ownerKey]);
  const [selectedJobId,setSelectedJobId]=useState('editing');
  const [pinnedNav,setPinnedNav]=useState('');
  const [conversationId,setConversationId]=useState('');
  const [helperConversationId,setHelperConversationId]=useState('');
  const [helperMode,setHelperMode]=useState(false);
  const [helperPrompt,setHelperPrompt]=useState('');const [scriptSourceJobId,setScriptSourceJobId]=useState('');
  const directorReferenceLimits:SelectionLimits|undefined=helperMode&&tab==='video'?{total:DIRECTOR_REFERENCE_LIMIT,byKind:DIRECTOR_MEDIA_LIMITS}:undefined;
  const genericVideoReferenceLimits:SelectionLimits={total:15,byKind:{image:12,video:12,audio:3}};
  const videoReferenceLimits:SelectionLimits|undefined=tab==='video'?(directorReferenceLimits||genericVideoReferenceLimits):undefined;
  const videoMaterialSnapshot=useRef<Draft['materials']>([]);
  const currentAssistApplication=matchingAssistApplication(assistApplication,prompts.video,tab==='video'?materials:videoMaterialSnapshot.current,{aspectRatio:aspectRatios.video,resolution:resolutions.video,duration,generateAudio:videoGenerateAudio});
  const currentDirectorApplication=matchingDirectorApplication(directorApplication,prompts.video,tab==='video'?materials:videoMaterialSnapshot.current,{aspectRatio:aspectRatios.video,resolution:resolutions.video,duration,generateAudio:videoGenerateAudio});
  const boundVideoApplication=currentAssistApplication||currentDirectorApplication;
  const requireVideoAudioToggle=videoGenerateAudio===false||Boolean(boundVideoApplication);
  const videoCapabilities=models.video.find(value=>modelSelectionId(value)===modelIds.video||value.id===modelIds.video)?.capabilities;
  const videoAudioToggleSupported=Boolean(videoCapabilities&&commerceVideoSupportsAudioToggle(videoCapabilities));
  const selectedVideoImageCount=materialGroups.video.filter(item=>item.type.startsWith('image/')).length;
  const selectedVideoAudioCount=materialGroups.video.filter(item=>item.type.startsWith('audio/')).length;
  const selectedVideoSourceCount=materialGroups.video.filter(item=>item.type.startsWith('video/')).length;
  const videoQuery=videoModelCatalogUrl({referenceImages:selectedVideoImageCount,sourceVideos:selectedVideoSourceCount,referenceAudios:selectedVideoAudioCount,duration,aspectRatio:aspectRatios.video,resolution:resolutions.video,requireAudioToggle:requireVideoAudioToggle,firstFrame:materialGroups.video.some(r=>r.slot==='first-frame'),lastFrame:materialGroups.video.some(r=>r.slot==='last-frame')});
  const videoQueryCurrent=loadedModelQueries.current.video?.url===videoQuery&&!modelCatalogs.video.error;
  let videoDurationPlan:ReturnType<typeof resolveCommerceVideoDurationPlan>|null=null,videoDurationIssue='';
  if(videoCapabilities)try{videoDurationPlan=resolveCommerceVideoDurationPlan(videoCapabilities,duration,{maximum:COMMERCE_VIDEO_MAX_TOTAL_DURATION});}catch(error){videoDurationIssue=error instanceof Error?error.message:'当前模型不支持该视频时长';}
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
  // 场景槽位激活时，素材按媒体类型和编导角色落位展示；不改变素材自身 slot（提交与绑定校验仍用原值）。
  const sceneSeat=(item:Material):string=>{
    if(tab!=='video'||!directorSceneActive||model?.capabilities.showLastFrame)return item.slot;
    if(slots.some(slot=>slot.id===item.slot))return item.slot;
    if(item.type.startsWith('audio/'))return slots.find(slot=>slot.kinds.includes('audio'))?.id||item.slot;
    const source=currentDirectorApplication?.sourceReferences.find(ref=>ref.id===(item.serverId||item.id));
    if(source?.sceneRole==='character')return slots.find(slot=>slot.id===sceneCharacterSlot||slot.label==='角色')?.id||item.slot;
    return slots.find(slot=>slot.label!=='角色'&&slot.kinds.includes(fileKind(item.type) as MaterialSlot['kinds'][number]))?.id||item.slot;
  };
  const slotMaterials=(slot:MaterialSlot)=>materials.filter(item=>sceneSeat(item)===slot.id);
  const selectedImageCount=materialGroups.image.filter(item=>item.type.startsWith('image/')).length;
  const selectedImageModel=models.image.find(item=>modelSelectionId(item)===modelIds.image||item.id===modelIds.image);
  const selectedImageMax=Number(selectedImageModel?.capabilities.maxReferenceImages??0);
  const nativeImageSize=tab==='image'?toApisStandardNativeSize(selectedImageModel?.capabilities.nativeImageContract,resolution,aspectRatio):null;
  const imageModelCapabilityIssue=tab==='image'&&!modelsLoading.image?(!selectedImageModel?'请选择一个图片模型。':selectedImageModel.selectionCompatible===false||selectedImageModel.modeCompatible===false?[...(selectedImageModel.selectionIncompatibleReasons||[]),...(selectedImageModel.modeIncompatibleReasons||[])].filter(Boolean).join('；')||'当前模型与参考图数量或图片设置不兼容。':selectedImageCount>0&&selectedImageModel.capabilities.supportsImageInput!==true&&selectedImageModel.capabilities.supportsReferenceInput!==true?'当前模型只支持文字生图；请移除参考图或更换支持参考图的模型。':selectedImageMax>0&&selectedImageCount>selectedImageMax?`当前模型最多支持 ${selectedImageMax} 张参考图，已选择 ${selectedImageCount} 张。`:''):'';
  const imageExecutionIssue=tab==='image'?(modelCatalogs.image.error||(!modelCatalogs.image.configurationReady?modelCatalogs.image.configurationMessage||'图片模型配置尚未发布，暂不可执行。':selectedImageModel?.generationReady!==true?selectedImageModel?.readinessMessage||'当前图片模型生成验收中，暂不可执行。':'')):'';
  function imageSlotOrder(){return getImageInputContract(imageSkillRef.current).slots.map(slot=>slot.id);}
  function imageEditingReferences(){return imageEditorReferences(referenceRecovery.current.get('image')?.snapshot.materials||materialRef.current.image);}
  function commitImageDocument(document:ImageReferenceDocument){imageDocumentRef.current=document;setImageDocument(document);const next={...promptValues.current,image:document.text};promptValues.current=next;setPromptValues(next);}
  function commitImageEditorEdit(document:ImageReferenceDocument){
    const currentLength=imageDocumentRef.current.text.length;
    if(document.text.length>Math.max(imagePromptLimit,currentLength)){
      showNotice('图片创作要求最多可输入 5000 字');
      return;
    }
    commitImageDocument(document);
  }
  function pasteImagePrompt(event:React.ClipboardEvent<HTMLTextAreaElement>){
    if(tab!=='image')return;
    const text=event.clipboardData.getData('text/plain');
    if(!text)return;
    event.preventDefault();
    const {selectionStart:start,selectionEnd:end}=event.currentTarget;
    const doc=imageDocumentRef.current;
    const remaining=Math.max(imagePromptLimit,doc.text.length)-doc.text.length+(end-start);
    const inserted=text.slice(0,remaining);
    if(!inserted)return;
    try{
      const updated=applyImageReferenceTextEdit(doc,{start,end,text:inserted},imageEditingReferences(),imageSlotOrder());
      commitImageEditorEdit(updated);
    }catch(error){showNotice((error as Error).message);}
  }
  function prepareImageSnapshot(snapshot:Draft){if(snapshot.kind!=='image')return snapshot;const slots=getImageInputContract(snapshot.skillId).slots.map(slot=>slot.id),materials=orderImageEditorMaterials(snapshot.materials,slots),document=restoreImageEditorDocument(snapshot.prompt,snapshot.imageReferenceDocument,materials,slots);return {...snapshot,materials,prompt:document.text,imageReferenceDocument:document};}
  function editorSnapshot(kind:RecoveryKind):Draft{return {id:drafts.some(item=>item.id===selectedDraft&&item.kind===kind)?selectedDraft:crypto.randomUUID(),title:kind==='image'?selectedSkill.name:kind==='video'?'视频创作':'Agent',kind,prompt:prompts[kind],skillId:kind==='image'?skillId:'default',createdAt:Date.now(),modelId:modelIds[kind]||'',...(kind==='image'?{imageReferenceDocument:imageDocumentRef.current,imageQuality}:{}),aspectRatio:aspectRatios[kind]||'1:1',resolution:resolutions[kind]||'1K',format,duration,materials:materialRef.current[kind].map(({id,serverId,name,type,slot})=>({id,serverId,name,type,slot})),...(kind==='video'?{director,scriptSourceJobId,assistApplication:assistApplication||undefined,directorApplication:directorApplication||undefined,helperConversationId,helperMode,helperPrompt,scriptLanguage,scriptDuration,generateAudio:videoGenerateAudio}:{}),...(kind==='agent'?{agent:{scenarioId,product:{...product},panels:[...panels],confirmed:planConfirmed}}:{})};}
  function persistEditor(snapshot:Draft,pending=false){
    const value=snapshot.kind==='video'?{mode:snapshot.helperMode?'director':'direct',director:snapshot.director||'default-director',prompt:snapshot.helperPrompt||'',language:snapshot.scriptLanguage||'中文',duration:snapshot.scriptDuration||15,conversationId:snapshot.helperConversationId||'',scriptSourceJobId:snapshot.scriptSourceJobId||'',assistApplication:snapshot.assistApplication||null,directorApplication:snapshot.directorApplication||null,videoPrompt:snapshot.prompt,videoMaterials:snapshot.materials,modelId:snapshot.modelId,videoSettings:{aspectRatio:snapshot.aspectRatio,resolution:snapshot.resolution,duration:snapshot.duration,generateAudio:snapshot.generateAudio!==false},pendingRecovery:pending}:snapshot.kind==='image'?{prompt:snapshot.prompt,skillId:snapshot.skillId,aspectRatio:snapshot.aspectRatio,resolution:snapshot.resolution,format:snapshot.format,imageQuality:snapshot.imageQuality,modelId:snapshot.modelId,materials:snapshot.materials,imageReferenceDocument:snapshot.imageReferenceDocument,pendingRecovery:pending}:{...snapshot,modelId:snapshot.modelId};
    const key=ownerKey+':'+snapshot.kind+'-editor-state',serialized=JSON.stringify(value);
    workspaceInputs.set(key,serialized);
    // Mirror to localStorage so a full page reload restores the editor like the reference site does.
    try{localStorage.setItem(key,serialized);}catch{/* Quota or privacy mode: transient in-memory draft still applies for this document. */}
  }
  function replaceEditorMaterials(kind:CommerceTab,next:Material[]){const old=materialRef.current[kind];materialRef.current={...materialRef.current,[kind]:next};setMaterialsFor(kind,next);old.filter(value=>value.url.startsWith('blob:')&&!Object.values(materialRef.current).some(group=>group.some(item=>item.url===value.url))).forEach(value=>URL.revokeObjectURL(value.url));}
  function applyEditorSnapshot(snapshot:Draft){
    if(snapshot.kind==='image'){imageSkillRef.current=snapshot.skillId;if(snapshot.imageReferenceDocument)commitImageDocument(snapshot.imageReferenceDocument);}
    setPrompts(current=>({...current,[snapshot.kind]:snapshot.prompt}));setModelIds(current=>({...current,[snapshot.kind]:snapshot.modelId||''}));setAspectRatios(current=>({...current,[snapshot.kind]:snapshot.aspectRatio}));setResolutions(current=>({...current,[snapshot.kind]:snapshot.resolution}));
    if(snapshot.kind==='image'){setImageQuality(snapshot.imageQuality);setSkillId(snapshot.skillId);setFormat(snapshot.format==='JPG'?'JPEG':snapshot.format);}
    if(snapshot.kind==='video'){setDuration(snapshot.duration);setDirector(snapshot.director||'default-director');setAssistApplication(snapshot.assistApplication||null);setDirectorApplication(snapshot.directorApplication||null);setHelperPrompt(snapshot.helperPrompt||'');setScriptLanguage(snapshot.scriptLanguage||'中文');setScriptDuration(restoreDirectorDuration(snapshot.scriptDuration));setVideoGenerateAudio(snapshot.generateAudio!==false);setScriptSourceJobId(snapshot.scriptSourceJobId||'');setHelperMode(snapshot.helperMode===true);setHelperConversationId(snapshot.helperConversationId||crypto.randomUUID());videoMaterialSnapshot.current=snapshot.materials;}
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
      setPrompts(current=>({...current,video:text}));setScriptSourceJobId(jobId);setAssistApplication(application||null);setDirectorApplication(null);setHelperMode(false);setAssistId('');if(referenceProjectOpen)void navigate('video');setSelectedJobId('editing');setPreviewTab('预览');void runtime.refresh();
    }catch(error){showNotice((error as Error).message);}finally{assistApplyLock.current=false;setAssistApplying(false);}
  }
  async function importCanaryDraft() {
    if(!canaryJobId||assistApplyLock.current||!editorRestored||blockPendingReferences('video'))return;
    if((prompts.video.trim()||materials.length)&&!window.confirm('用所选验收稿件及其参考素材替换当前视频编辑内容？'))return;
    const sequence=navigationSequence.current;
    assistApplyLock.current=true;
    setAssistApplying(true);
    try {
      const response=await fetch('/api/admin/commerce/cards/canary?view=video-draft&jobId='+encodeURIComponent(canaryJobId),{
        headers:{Authorization:'Bearer '+(localStorage.getItem('auth_token')||'')},cache:'no-store'
      });
      const data=await response.json();
      if(!response.ok)throw Error(typeof data.error==='string'?data.error:'请在带货管理页验证身份后再应用稿件');
      const draft=data.draft as {jobId:string;script:string;duration:number;generateAudio:boolean;materials:MaterialReference[]};
      if(draft.jobId!==canaryJobId)throw Error('原单与所选稿件不一致');
      const result=await recoverMaterials(draft.materials);
      if(sequence!==navigationSequence.current||currentTab.current!=='video')return;
      if(result.missing.length)throw Error('原单的参考素材不可用，请重新核对');
      clearMaterials();
      setMaterials(result.materials);
      videoMaterialSnapshot.current=result.materials;
      setPrompts(previous=>({...previous,video:draft.script}));
      setDuration(draft.duration);
      setVideoGenerateAudio(draft.generateAudio);
      setAssistApplication(null);
      setDirectorApplication(null);
      setScriptSourceJobId(draft.jobId);
      setHelperMode(false);
      setSelectedJobId('editing');
      setPreviewTab('预览');
      showNotice('验收稿件及参考素材已应用，可核对模型和报价。');
    } catch(error){showNotice((error as Error).message);}
    finally{assistApplyLock.current=false;setAssistApplying(false);}
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
      const saved=JSON.parse(workspaceInputs.get(ownerKey+':'+kind+'-editor-state')||(typeof localStorage==='undefined'?'null':localStorage.getItem(ownerKey+':'+kind+'-editor-state'))||'null');if(!saved)continue;
      const snapshot=editorSnapshot(kind),refs=kind==='video'?saved.videoMaterials:saved.materials;
      const maxSavedReferences=kind==='video'&&saved.mode==='director'?DIRECTOR_REFERENCE_LIMIT:15;
      if(!Array.isArray(refs)||refs.length>maxSavedReferences||refs.some(ref=>!ref||typeof ref.id!=='string'||typeof ref.name!=='string'||typeof ref.type!=='string'||typeof ref.slot!=='string'||ref.serverId!==undefined&&typeof ref.serverId!=='string'))throw Error('草稿中的素材引用格式不正确，请保留原草稿后重新选择');
      snapshot.materials=refs;if(kind==='image')snapshot.imageReferenceDocument=saved.imageReferenceDocument;snapshot.prompt=String(kind==='video'?saved.videoPrompt||'':saved.prompt||'');snapshot.modelId=typeof saved.modelId==='string'?saved.modelId:'';
      if(kind==='video'){const settings=saved.videoSettings||{};snapshot.aspectRatio=typeof settings.aspectRatio==='string'?settings.aspectRatio:snapshot.aspectRatio;snapshot.resolution=typeof settings.resolution==='string'?settings.resolution:snapshot.resolution;snapshot.duration=Number.isFinite(settings.duration)?settings.duration:snapshot.duration;snapshot.generateAudio=settings.generateAudio!==false;snapshot.director=String(saved.director||'default-director');snapshot.helperMode=saved.mode==='director';snapshot.helperPrompt=String(saved.prompt||'');snapshot.scriptLanguage=String(saved.language||'中文');snapshot.scriptDuration=Number(saved.duration)||15;snapshot.helperConversationId=String(saved.conversationId||crypto.randomUUID());snapshot.scriptSourceJobId=String(saved.scriptSourceJobId||'');snapshot.assistApplication=saved.assistApplication||undefined;snapshot.directorApplication=saved.directorApplication||undefined;}
      if(kind==='image'){let routeSkill;try{routeSkill=imageRailSkillFromPath(commerceInternalPath(window.location.pathname+window.location.search));}catch{/* Invalid route is reported by applyWorkspacePath; retain the saved draft. */}snapshot.skillId=routeSkill?.localId||(imageSkills.some(value=>value.id===saved.skillId)?saved.skillId:'default');snapshot.imageQuality=isDetailImageQuality(saved.imageQuality)?saved.imageQuality:undefined;snapshot.format=['PNG','JPEG','JPG','WEBP'].includes(saved.format)?saved.format:'PNG';snapshot.aspectRatio=typeof saved.aspectRatio==='string'?saved.aspectRatio:snapshot.aspectRatio;snapshot.resolution=typeof saved.resolution==='string'?saved.resolution:snapshot.resolution;}
      if(kind==='agent'&&saved.agent)snapshot.agent=saved.agent;
      startEditorRecovery(snapshot);
    }catch(error){showNotice('编辑草稿恢复失败：'+(error as Error).message);}
    setEditorRestored(true);setImageEditorRestored(true);return()=>coordinator.dispose();
  },[ownerKey]);
  useEffect(()=>{if(!editorRestored)return;const snapshot=editorSnapshot('video'),pending=referenceRecovery.current.get('video');if(pending){snapshot.materials=pending.snapshot.materials;referenceRecovery.current.update('video',snapshot);}videoMaterialSnapshot.current=snapshot.materials;try{persistEditor(snapshot,!!pending);}catch{showNotice('视频草稿暂时无法自动保存，请检查浏览器存储空间。');}},[materialGroups.video,tab,aspectRatios.video,resolutions.video,duration,videoGenerateAudio,assistApplication,directorApplication,prompts.video,scriptSourceJobId,editorRestored,helperMode,director,helperPrompt,scriptLanguage,scriptDuration,helperConversationId,modelIds.video,ownerKey,showNotice]);
  const [imageEditorRestored,setImageEditorRestored]=useState(false);
  useEffect(()=>{if(!imageEditorRestored)return;const snapshot=editorSnapshot('image'),pending=referenceRecovery.current.get('image');if(pending){snapshot.materials=pending.snapshot.materials;referenceRecovery.current.update('image',snapshot);}try{persistEditor(snapshot,!!pending);}catch{showNotice('图片草稿暂时无法自动保存，请检查浏览器存储空间。');}},[imageEditorRestored,tab,prompts.image,imageDocument,imageQuality,skillId,aspectRatios.image,resolutions.image,format,materialGroups.image,modelIds.image,ownerKey,showNotice]);
  // Cross-tool or library references arrive with an unknown slot: seat them into open
  // slots in display order so the manual assignment row only appears for true overflow.
  useEffect(()=>{
    if(tab!=='image'||!imageEditorRestored||referenceRecovery.current.get('image'))return;
    const current=materialRef.current.image,next=assignOpenImageSlots(current,getImageInputContract(skillId).slots);
    if(next!==current)setMaterialsFor('image',next);
  },[tab,skillId,materialGroups.image,imageEditorRestored,setMaterialsFor]);
  useEffect(()=>{if(!editorRestored||tab!=='agent')return;const snapshot=editorSnapshot('agent'),pending=referenceRecovery.current.get('agent');if(pending){snapshot.materials=pending.snapshot.materials;referenceRecovery.current.update('agent',snapshot);}try{persistEditor(snapshot,!!pending);}catch{showNotice('Agent 草稿暂时无法自动保存，请检查浏览器存储空间。');}},[editorRestored,tab,prompts.agent,materialGroups.agent,modelIds.agent,scenarioId,product,panels,planConfirmed,ownerKey,showNotice]);
  function chooseDirector(key:string){if(blockPendingReferences('video'))return;const brief=key.startsWith('brief:')?key.slice(6):'';const spec=directorCards.find(d=>isDirectorScene(brief)?d.key==='default-director':d.key===key||d.name===key);if(!spec){showNotice('此编导在当前后台目录中不可用，请重新选择');return;}setSelectedJobId('editing');setPreviewTab('预览');const selection=isDirectorScene(brief)?key:spec.key;const carried=workspaceInputs.get(ownerKey+':home-director-brief');if(carried!=null)workspaceInputs.delete(ownerKey+':home-director-brief');if(selection===director){if(carried!=null)setHelperPrompt(carried);if(currentDirectorApplication)setMaterials(current=>current.map((material,index)=>{const source=currentDirectorApplication.sourceReferences[index];return source&&source.id===(material.serverId||material.id)?{...material,id:source.instanceId||source.id,slot:source.sceneRole==='character'?(directorSpec.slots.find(s=>s.label==='角色')?.key||sceneCharacterSlot):source.slot}:material;}));setHelperMode(true);setDirectorOpen(false);setSettingsOpen(false);setModelOpen(false);return;}setAssistApplication(null);setDirectorApplication(null);setScriptSourceJobId('');setDirector(selection);setModelIds(current=>({...current,agent:''}));setHelperMode(true);setDirectorOpen(false);setSettingsOpen(false);setModelOpen(false);setHelperPrompt(carried||'');setHelperConversationId(crypto.randomUUID());setMaterials(current=>current.map(m=>{const oldRole=directorSlots.find(slot=>slot.key===m.slot)?.label;const compatible=spec.slots.filter(s=>s.kinds.includes(fileKind(m.type)));const slot=oldRole==='角色'&&directorReferenceLayout(spec,isDirectorScene(brief)?brief:undefined).actor?(compatible.find(s=>s.label==='角色')?.key||sceneCharacterSlot):(compatible.find(s=>s.label===oldRole)?.key||compatible[0]?.key||m.slot);return {...m,slot};}));}
  const appliedRouteScene=useRef('');
  useEffect(()=>{
    if(!groupDirectorKey)setGroupHandoff(previous=>previous.key?{key:'',error:''}:previous);
    if(!studioScene||groupBuyOpen||storyboardOpen||tab!=='video'){appliedRouteScene.current='';return;}
    if(!editorRestored||!directorCards.length||appliedRouteScene.current===studioScene)return;
    const useGeneral=manualSceneNeeded(studioScene,directorCards)&&isDirectorScene(studioScene);
    const card=useGeneral?directorCards.find(c=>c.key==='default-director'):directorCards.find(c=>c.key===studioScene||sceneKeys[c.key]===studioScene);
    let alive=true;
    if(card){
      const key=studioScene+'|'+studioProjectId+'|'+studioMode+'|'+studioVersionId;
      if(appliedRouteScene.current===key)return;
      if(studioScene===groupBuyScene&&studioProjectId&&studioMode==='director'){
        void api<{project:StoreProject;versions:StudioVersion[]}>('/api/commerce/studio/projects?projectId='+encodeURIComponent(studioProjectId)).then(({project,versions})=>{
          if(!alive)return;
          const version=studioVersionId?versions.find(item=>item.id===studioVersionId):undefined;
          if(studioVersionId&&!version)throw Error('所选分镜版本不存在，请回到团购项目重新选择。');
          const draft=groupBuyDirectorDraft(project,version);
          chooseDirector(card.key);setHelperConversationId(version?.id||project.id);setHelperPrompt(draft.prompt);
          if(draft.prompt.length>8000)showNotice('编导单次最多接收 8000 字，已保留完整分镜，请在输入框中精简后发送。');
          const slot=card.slots.find(s=>s.kinds.includes('image'))?.key||'reference';
          setMaterialsFor('video',draft.imageIds.map((id,i)=>({id,serverId:id,name:'菜品参考 '+(i+1),type:'image/png',url:'/api/commerce/assets/'+encodeURIComponent(id),slot,size:0})));
          appliedRouteScene.current=key;setGroupHandoff({key:groupDirectorKey,error:''});
        }).catch(e=>{if(alive)setGroupHandoff({key:groupDirectorKey,error:e.message});});
      }else {appliedRouteScene.current=key;chooseDirector(useGeneral?'brief:'+studioScene:card.key);}
    }
    else showNotice('当前发布目录中没有此编导，请从场景栏选择。');
    return ()=>{alive=false;};
  },[studioScene,studioMode,studioProjectId,studioVersionId,groupDirectorKey,groupBuyOpen,storyboardOpen,tab,editorRestored,directorCards]);
  function exitDirector(){setSelectedJobId('editing');setPreviewTab('预览');setScriptSourceJobId('');setHelperMode(false);setMaterials(current=>directorSceneActive?current:current.map(m=>({...m,slot:m.type.startsWith('audio/')?'sound':'reference'})));}
  const savedEditorDraft=(tab==='image'||tab==='video')?drafts.find(draft=>{
    if(draft.kind!==tab||draft.prompt!==prompt||draft.aspectRatio!==aspectRatio||draft.resolution!==resolution||(draft.modelId||'')!==(modelIds[tab]||''))return false;
    if(draft.materials.length!==materials.length||!draft.materials.every((ref,i)=>ref.id===materials[i].id&&ref.slot===materials[i].slot))return false;
    if(tab==='image')return draft.skillId===skillId&&draft.format===format&&JSON.stringify(draft.imageReferenceDocument?.mentions||[])===JSON.stringify(imageDocument.mentions);
    return draft.director===director&&draft.helperMode===helperMode&&draft.helperConversationId===helperConversationId&&
      (draft.helperPrompt||'')===helperPrompt&&draft.scriptDuration===scriptDuration&&draft.scriptLanguage===scriptLanguage&&
      draft.generateAudio===videoGenerateAudio&&draft.duration===duration&&draft.scriptSourceJobId===scriptSourceJobId;
  }):undefined;
  const relevantJobs=runtime.jobs.filter(j=>j.input.kind===mediaKind);
  const favoriteJobs=relevantJobs.filter(job=>favoriteIds.includes('job:'+job.id));
  const favoriteScenes=scenarios.filter(scene=>favoriteIds.includes(scene.id)&&(tab==='image'?scene.id==='image-create':scene.id!=='image-create'));
  const inlinePicker=tab==='video'?directorOpen&&!!studioGroup:tab==='image'&&skillOpen&&homeImagePicker;
  const pickerGroupName=Object.keys(groupKeys).find(name=>groupKeys[name]===studioGroup);
  const groupDefault=tab==='video'&&inlinePicker?visibleSceneCards(directorCards).filter(card=>card.category===pickerGroupName).sort((a,b)=>sceneSidebarOrder(a.key)-sceneSidebarOrder(b.key))[0]:undefined;
  const initializedGroup=useRef('');
  useEffect(()=>{
    if(!studioGroup){initializedGroup.current='';return;}
    if(!groupDefault||initializedGroup.current===studioGroup||!editorRestored||referenceRecovery.current.get('video'))return;
    initializedGroup.current=studioGroup;
    chooseDirector(groupDefault.key);
    setDirectorOpen(true);
  },[studioGroup,groupDefault?.key,editorRestored]);
  function clearPickerSelection(){
    if(tab==='video'){setDirectorOpen(false);exitDirector();setDirector('default-director');}
    else {const item=imageSkills.find(i=>i.id==='default');if(item)openSkill(item);}
  }
  const selectedJob=selectedJobId==='latest'?relevantJobs.find(j=>j.status==='succeeded'&&j.assetIds.length):relevantJobs.find(j=>j.id===selectedJobId);
  function toggleJobFavorite(id:string){setFavoriteIds(current=>{const key='job:'+id;const next=current.includes(key)?current.filter(x=>x!==key):[...current,key];localStorage.setItem(ownerKey+':favorites',JSON.stringify(next));return next;});}
  useEffect(()=>{setConversationId(current=>current||crypto.randomUUID());setHelperConversationId(current=>current||crypto.randomUUID());},[conversationId,helperConversationId]);
  useEffect(()=>{const sync=async()=>{const path=window.location.pathname+window.location.search,oldPath=workspacePath.current;if(path!==oldPath&&groupLeave.current&&!groupLeave.current()){window.history.pushState(null,'',oldPath);return;}const attempt=++navigationSequence.current;const leave=depthOpenRef.current?depthBeforeLeave.current:detailOpenRef.current?detailBeforeLeave.current:null;try{if(leave&&oldPath!==path&&!await leave()){if(attempt===navigationSequence.current)window.history.pushState(null,'',oldPath);return;}if(attempt===navigationSequence.current)applyWorkspacePath(path,true);}catch(error){if(attempt===navigationSequence.current){window.history.pushState(null,'',oldPath);showNotice('当前内容尚未保存：'+(error as Error).message);}}};void sync();window.addEventListener('popstate',sync);return()=>window.removeEventListener('popstate',sync);},[]);
  useEffect(()=>{if(!model||(tab==='video'&&(assistApplication||directorApplication)))return;const caps=model.capabilities;const resolvedResolutions=tab==='video'?commerceVideoResolutionOptions(caps).options:Array.isArray(caps.resolutionOptions)?caps.resolutionOptions.map(String):[];const ratios=caps.aspectRatios;if(resolvedResolutions.length&&!resolvedResolutions.some(value=>value.toLowerCase()===resolution.toLowerCase()))setResolution(String(caps.defaultResolution||resolvedResolutions[0]));if(!(mediaKind==='image'&&['auto','自适应'].includes(aspectRatio))&&Array.isArray(ratios)&&ratios.length&&!ratios.includes(aspectRatio))setAspectRatio(String(ratios[0]));if(tab==='video'){const targets=commerceVideoTargetDurations(caps,{maximum:COMMERCE_VIDEO_MAX_TOTAL_DURATION});if(targets.length&&!targets.some(value=>Math.abs(value-duration)<1e-8))setDuration(targets.reduce((closest,value)=>Math.abs(value-duration)<Math.abs(closest-duration)?value:closest,targets[0]));}},[model?.id,tab]);
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
    if(kind==='image'&&imageSkills.find(s=>s.id===meta.image_skill_id)?.canvasOnly)throw Error('这项图片技能需要连接画布来源，请在画布中使用。');
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
        if(!videoQueryCurrent)throw Error('正在按本次素材和设置核对渠道，请稍候');
        if(!model||!modelIds.video)throw Error(videoSelectionIssue||'请选择一个与当前素材和视频设置兼容的模型。');
        if(model.selectionCompatible===false||model.modeCompatible===false)throw Error([...(model.selectionIncompatibleReasons||[]),...(model.modeIncompatibleReasons||[])].filter(Boolean).join('；')||'当前视频模型与素材或设置不兼容。');
        if(model.generationReady!==true)throw Error(model.readinessMessage||'当前视频模型生成验收中，暂不可执行。');
      }
      const startingText=prompt;
      if(tab==='image'){validateImageInput({skillId,prompt,format,references:materials.map(m=>({id:m.serverId||m.id,slot:m.slot}))},materials.map(m=>({id:m.serverId||m.id,type:m.type})));validateImageReferenceDocument(imageDocumentRef.current,prompt,imageEditingReferences(),imageSlotOrder(),{allowUnresolved:true});if(imageDocumentRef.current.mentions.some(value=>['missing','unassigned'].includes(value.status))||imageLegacyFilenameMentions(prompt,imageEditingReferences()).length)throw Error('图片引用尚未明确，请先修复标出的引用');}
      const refs=await references();let imageReferenceDocument:ImageReferenceDocument|undefined;
      if(tab==='image'){if(imageDocumentRef.current.text!==startingText)throw Error('上传期间图片正文已改变，请核对后重新提交');imageReferenceDocument=validateImageReferenceDocument(imageDocumentRef.current,startingText,imageEditingReferences(),imageSlotOrder());}
      const value=await runtime.submit({kind:mediaKind as 'image'|'video',modelId:modelCatalogs[mediaKind].userSelectable?modelIds[mediaKind]:undefined,prompt:startingText,skillId:tab==='image'?skillId:undefined,aspectRatio,resolution,format:tab==='image'?format:undefined,imageQuality:tab==='image'?effectiveImageQuality:undefined,imageReferenceDocument,duration,generateAudio:tab==='video'&&videoAudioToggleSupported?videoGenerateAudio:undefined,assistApplicationId:tab==='video'?currentAssistApplication?.id:undefined,directorApplicationId:tab==='video'?currentDirectorApplication?.id:undefined,parentJobId:tab==='video'&&scriptSourceJobId?scriptSourceJobId:undefined,references:refs});setSelectedJobId(value.id);setPreviewTab('预览');setShowImageExample(false);showNotice('任务已提交，结果会保存到带货创作资产库。');
    }catch(error){showNotice((error as Error).message);}
  }
  function preferenceModelOptions(kind:PreferenceMedia){
    const ordered=[...models[kind]].sort((a,b)=>(a.agentPreferenceRank??99)-(b.agentPreferenceRank??99));
    return ordered.map(m=>({id:modelSelectionId(m),name:m.displayName,available:modelCatalogs[kind].userSelectable&&canConfigureModel(m)}));
  }
  const preferenceModels={video:preferenceModelOptions('video'),image:preferenceModelOptions('image')};
  useEffect(()=>{
    if(tab!=='agent')return;
    let live=true;setPrefsLoaded(false);
    api<{preferences:AgentPreferences}>('/api/commerce/studio/preferences').then(d=>{if(live){setAgentPrefs(d.preferences);setPrefsLoaded(true);}}).catch(()=>{if(live)showNotice('Agent 偏好暂时无法读取，请重新打开 Agent。');});
    return()=>{live=false;};
  },[tab,ownerKey,showNotice]);
  async function changeAgentPreference(kind:PreferenceMedia,field:keyof MediaPreferences,value:string){
    if(preferenceWrite.current)return false;preferenceWrite.current=true;setPrefsSaving(true);
    try{const data=await api<{preferences:AgentPreferences}>('/api/commerce/studio/preferences',{kind,field,value});setAgentPrefs(data.preferences);return true;}
    catch(error){showNotice((error as Error).message);return false;}
    finally{preferenceWrite.current=false;setPrefsSaving(false);}
  }
  function useMediaPreferences(kind:PreferenceMedia){
    const pref=agentPrefs[kind],choice=preferenceModels[kind].find(m=>m.available&&m.id===pref.model);
    if(choice)setModelIds(old=>({...old,[kind]:choice.id}));
    const target=models[kind].find(m=>modelSelectionId(m)===(choice?.id||modelIds[kind])),caps=target?.capabilities||{};
    const allows=(options:unknown,v:string)=>!Array.isArray(options)||options.length===0||options.some(x=>String(x).toLowerCase()===v.toLowerCase());
    if(pref.ratio&&allows(caps.aspectRatios,pref.ratio))setAspectRatios(old=>({...old,[kind]:pref.ratio}));
    if(pref.resolution&&allows(caps.resolutionOptions,pref.resolution))setResolutions(old=>({...old,[kind]:pref.resolution}));
    if(kind==='video'&&pref.duration&&allows(caps.nativeDurations||caps.durationOptions,pref.duration))setDuration(Number(pref.duration));
    if(kind==='image'&&pref.format&&allows(caps.supportedFormats||caps.outputFormats,pref.format))setFormat(pref.format);
  }
  async function sendChat(helper=false){try{if(!helper&&agentSkill&&!agentSkill.route&&!isMemberChatSkill(agentSkill.id))throw Error('此技能的执行功能尚未接入。');const selected=models.agent.find(item=>modelSelectionId(item)===modelIds.agent||item.id===modelIds.agent);if(!selected||!modelIds.agent)throw Error('请在当前对话中选择后台已配置的模型。');if(!modelCatalogs.agent.configurationReady||selected.generationReady!==true)throw Error(selected.readinessMessage||modelCatalogs.agent.configurationMessage||'对话模型待验收，暂不可执行。');const task=helper?helperPrompt:agentSkill&&!isMemberChatSkill(agentSkill.id)?['使用技能：'+agentSkill.name,agentSkill.detail||agentSkill.description,'根据已提供的素材和要求整理可执行方案；文件制作在该技能工作区完成。',prompt].join('\n'):prompt;const content=[task,!helper&&prefsLoaded?preferenceBrief(agentPrefs,preferenceModels):''].filter(Boolean).join('\n\n');const value=await runtime.submit({kind:'agent',modelId:modelCatalogs.agent.userSelectable&&!helper?modelIds.agent:undefined,prompt:content,conversationId:helper?helperConversationId:conversationId,purpose:helper?'director':'agent',skillId:!helper&&agentSkill&&isMemberChatSkill(agentSkill.id)?agentSkill.id:undefined,director:helper?director:undefined,spokenLanguage:helper?scriptLanguage:undefined,scriptDuration:helper?scriptDuration:undefined,references:await references()});if(helper)setHelperPrompt('');else setPrompt('');setSelectedJobId(value.id);}catch(e){showNotice((e as Error).message);}}
  async function reuseJob(value:UIJob){
    const kind=value.input.kind as RecoveryKind,snapshot=editorSnapshot(kind),input=value.input;
    snapshot.prompt=input.prompt;snapshot.modelId=input.modelId||'';snapshot.skillId=input.skillId||'default';snapshot.aspectRatio=input.requestedAspectRatio||input.aspectRatio||snapshot.aspectRatio;snapshot.resolution=input.resolution||snapshot.resolution;snapshot.duration=input.duration||snapshot.duration;
    if(kind==='image'){snapshot.imageQuality=isDetailImageQuality(input.imageQuality)?input.imageQuality:undefined;const saved=String(input.format||'PNG').toUpperCase();snapshot.format=saved==='JPG'?'JPEG':['PNG','JPEG','WEBP'].includes(saved)?saved:'PNG';}
    if(kind==='video'){snapshot.assistApplication=undefined;snapshot.directorApplication=undefined;snapshot.generateAudio=input.generateAudio!==false;snapshot.scriptSourceJobId=input.parentJobId||'';snapshot.helperMode=false;snapshot.director='default-director';snapshot.helperPrompt='';snapshot.helperConversationId=crypto.randomUUID();}
    snapshot.materials=(input.references||[]).map(ref=>({id:kind==='image'?ref.instanceId||crypto.randomUUID():crypto.randomUUID(),serverId:ref.id,name:ref.id,type:'',slot:ref.slot}));if(kind==='image')snapshot.imageReferenceDocument=input.imageReferenceDocument;
    if(startEditorRecovery(snapshot)){setSelectedDraft('');void navigate(kind);}
  }
  function useAsset(asset:UIAsset){const kind=asset.type.startsWith('image/')?'image':'video';if(blockPendingReferences(kind))return;setMaterialsFor(kind,current=>[...current.filter(m=>m.serverId!==asset.id),{...asset,id:crypto.randomUUID(),slot:asset.type.startsWith('audio/')?'sound':'reference',serverId:asset.id}]);navigate(kind);}
  function useChat(text:string,kind:'image'|'video'|'canvas'){if(kind==='video'){setScriptSourceJobId('');setHelperConversationId(crypto.randomUUID());}if(kind==='canvas'){workspaceInputs.set(ownerKey+':canvas-brief',text);setDetailTemplate(v=>v+1);navigate('canvas');}else{if(tab==='agent'&&prefsLoaded)useMediaPreferences(kind);setPrompts(current=>({...current,[kind]:text}));navigate(kind);}setHelperMode(false);}
  const selectedAgentModel=models.agent.find(item=>modelSelectionId(item)===modelIds.agent||item.id===modelIds.agent);
  const agentExecutionIssue=modelCatalogs.agent.error||(!modelCatalogs.agent.configurationReady?modelCatalogs.agent.configurationMessage||'对话模型配置尚未发布，暂不可执行。':selectedAgentModel?.generationReady!==true?selectedAgentModel?.readinessMessage||'当前对话模型待验收，暂不可执行。':'');
  const agentReadinessText=modelsLoading.agent?'正在读取模型…':!selectedAgentModel?'暂无可选择模型':agentExecutionIssue?`可选择配置 · ${agentExecutionIssue} · 暂不可执行`:'主站配置已启用，可执行';
  const closeChatModel=useCallback(()=>setModelOpen(false),[]);
  const chatModelSelect=<div className="ca-chat-model-control" data-testid="commerce-agent-model-picker">{modelOpen&&<div className="ca-model-popover-host" data-testid="commerce-agent-model-list"><ModelPopover items={pickerModels(models.agent,'agent')} selected={modelIds.agent} onSelect={id=>setModelIds(current=>({...current,agent:id}))} onClose={()=>setModelOpen(false)}/></div>}<button type="button" className="ca-model-select" data-popover-trigger data-testid="commerce-agent-model-trigger" aria-label="选择对话模型" aria-expanded={modelOpen} disabled={!modelsLoading.agent&&!models.agent.length} onClick={()=>{setModelOpen(value=>!value);setSettingsOpen(false);}}><Sparkles size={16}/><span>对话模型<strong>{selectedAgentModel?.displayName||(modelsLoading.agent?'正在读取…':'暂不可选')}</strong></span><ChevronDown size={13}/></button><small role="status" data-testid="commerce-agent-model-status" className={agentExecutionIssue?'ca-model-status-blocked':'ca-model-status-ready'}>{agentReadinessText}</small></div>;
  useEffect(() => { materialRef.current = materialGroups; }, [materialGroups]);
  useEffect(() => () => { Object.values(materialRef.current).flat().forEach(item => URL.revokeObjectURL(item.url)); if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);
  useEffect(() => {
    let active = true;
    let loading = false;
    async function load() {
      if(loading)return;loading=true;
      const endpoints:Record<ModelKind,string> = {
        video:videoQuery,
        image:`/api/commerce/models?kind=image&operationId=${encodeURIComponent(`image.${skillId||'default'}`)}&referenceImages=${selectedImageCount}`,
        agent:'/api/commerce/models?kind=agent&operationId=agent.chat',
      };
      await Promise.allSettled(Object.entries(endpoints).map(async ([kind, url]) => {
        const modelKind=kind as ModelKind;
        const previous=loadedModelQueries.current[modelKind];
        if(previous?.url===url&&Date.now()-previous.at<25_000)return;
        try {
          const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
          if (!response.ok) throw Error(modelKind);
          const data = await response.json();
          const values: Model[] = (Array.isArray(data.models) ? data.models : []).filter((item: Model) => item && typeof item.id === 'string' && typeof item.displayName === 'string' && item.capabilities && typeof item.capabilities === 'object');
          if (!active) return;
          loadedModelQueries.current[modelKind]={url,at:Date.now()};
          if(modelKind==='video'&&data.memberVideoDirectory)for(const item of values){
            for(const id of item.memberChannelIds||[modelSelectionId(item)])videoSkuById.current.set(id,item.displayName);
          }
          setModels(current => ({ ...current, [modelKind]: values }));
          setModelIds(current => {
            const preferred=String(data.defaultCompatibleModelId||data.defaultModelId||'');
            const preferredModel=values.find(item=>item.id===preferred||modelSelectionId(item)===preferred);
            const preferredSelection=preferredModel?modelSelectionId(preferredModel):preferred;
            const selectedSku=modelKind==='video'&&data.memberVideoDirectory?videoSkuById.current.get(current.video):undefined;
            const sameSku=selectedSku?values.find(item=>item.displayName===selectedSku):undefined;
            const next=sameSku?modelSelectionId(sameSku):modelKind==='video'&&!data.memberVideoDirectory?availableModelId(values.map(item=>({...item,id:modelSelectionId(item)})),current[modelKind],preferredSelection):configuredModelId(values,current[modelKind],preferredSelection);
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
  }, [skillId,selectedImageCount,videoQuery]);
  const loadLibrary = useCallback(async () => {
    try { const rows = await listMaterials(); libraryRef.current.forEach(item => URL.revokeObjectURL(item.url)); const next = rows.sort((a, b) => b.createdAt - a.createdAt).map(item => ({ ...item, url: URL.createObjectURL(item.blob) })); libraryRef.current = next; setLibrary(next); }
    catch { showNotice('素材库暂时无法读取，请检查浏览器存储权限。'); }
  }, [showNotice]);
  useEffect(() => { void loadLibrary(); return () => libraryRef.current.forEach(item => URL.revokeObjectURL(item.url)); }, [loadLibrary]);
  function applyImageRailPath(path:string){
    const selected=imageRailSkillFromPath(path);if(!selected||selected.localId===imageSkillRef.current)return;
    const skill=imageSkills.find(value=>value.id===selected.localId&&!value.canvasOnly);if(!skill)throw Error('此图片技能尚不可用，请从 AI 图片页面重新选择');
    // Preserve complete references while a prior recovery is loading/failed. begin() cancels its epoch.
    const pending=referenceRecovery.current.get('image'),snapshot={...(pending?.snapshot||editorSnapshot('image')),skillId:skill.id};
    snapshot.materials=assignOpenImageSlots(snapshot.materials,getImageInputContract(skill.id).slots);
    if(!pending){snapshot.prompt=promptValues.current.image;snapshot.imageReferenceDocument=imageDocumentRef.current;}
    if(!startEditorRecovery(snapshot))throw Error('图片技能与草稿尚未保存，仍停留在原入口');
    setSelectedDraft('');setSelectedJobId('editing');
  }
  function applyWorkspacePath(path:string,fromBrowser=false){
    setPinnedNav('');setHomeImagePicker(false);
    const internalPath=commerceInternalPath(path);
    applyImageRailPath(internalPath);
    const url=new URL(internalPath,window.location.origin),routes:Record<string,CommerceTab>={'/agent-chat':'agent','/toolbox/video-generation':'video','/toolbox/image-generation':'image','/canvas':'canvas','/assets':'assets'};
    setCanaryJobId(url.pathname===videoPath?url.searchParams.get('canaryJob')||'':'');
    setSkillView(url.searchParams.get('view')||'');
    if(url.pathname==='/agent-chat'&&url.searchParams.get('conversation'))setConversationId(url.searchParams.get('conversation')!);
    setAgentSkillId(url.pathname==='/agent-chat'?url.searchParams.get('skill')||'':'');
    if(url.pathname==='/skills'&&url.searchParams.get('view')==='save'){
      try{const draft=JSON.parse(workspaceInputs.get(ownerKey+':new-skill')||'null');setSkillDraft(draft&&typeof draft.text==='string'&&typeof draft.id==='string'?draft:null);}catch{setSkillDraft(null);}
    }else setSkillDraft(null);
    if(url.pathname!==videoPath)workspaceInputs.delete(ownerKey+':home-director-brief');
    setExtraView(['/skills','/characters'].includes(url.pathname)?url.pathname.slice(1):'');
    const defaultVideoEntry=fromBrowser&&url.pathname===videoPath&&!url.search;
    setStudioScene(url.pathname===videoPath?url.searchParams.get('scene')||(defaultVideoEntry?sceneKeys['ecommerce-spoken-selling']:''):'');
    setLibraryView(url.searchParams.get('tab')||'materials');
    setStudioMode(url.searchParams.get('mode')||(defaultVideoEntry?'director':''));
    setStudioGroup(url.searchParams.get('group')||'');setStudioProjectId(url.searchParams.get('projectId')||'');setStudioVersionId(url.searchParams.get('versionId')||'');
    workspacePath.current=commerceBrowserPath(internalPath);
    setReferenceProjectOpen((url.pathname===videoPath&&url.searchParams.get('project')==='reference')||(url.pathname==='/toolbox/hot-video-remix'&&url.searchParams.get('mode')!=='batch'));
    const tools:Record<string,string>={'/toolbox/video-watermark-remove':'水印擦除','/toolbox/video-subtitle-erase':'字幕擦除','/toolbox/video-quality-enhance':'画质增强','/toolbox/video-face-mosaic':'人脸打码','/toolbox/video-editor':'剪辑台'};
    const nextDepth=url.pathname==='/toolbox/depth-video-clone'||url.pathname==='/toolbox/hot-video-remix'&&!url.searchParams.get('mode')&&!url.searchParams.get('projectId'),nextDetail=url.pathname==='/toolbox/ecommerce-image-set',nextHotRemix=url.pathname==='/toolbox/hot-video-remix',nextVoice=url.pathname==='/toolbox/voice-synthesis',nextUtility=tools[url.pathname]||'';
    const next=nextDepth||nextUtility?'video':nextDetail?'image':routes[url.pathname]||'home';
    const previous=currentTab.current;if(previous!==next&&['image','video','agent'].includes(previous)&&referenceRecovery.current.pause(previous as RecoveryKind))refreshRecovery();currentTab.current=next;
    depthOpenRef.current=nextDepth;detailOpenRef.current=nextDetail;setDepthOpen(nextDepth);setDetailOpen(nextDetail);setHotRemixOpen(nextHotRemix);setVoiceOpen(nextVoice);setDepthSessionId(nextDepth?url.searchParams.get('session')||'':'');setUtility(nextUtility);setUtilityAssetId(nextUtility?url.searchParams.get('assetId')||'':'');setTab(next);
    if(next!=='canvas')setDetailTemplate(0);setModelOpen(false);setDirectorOpen(url.pathname===videoPath&&Object.values(groupKeys).includes(url.searchParams.get('group')||''));setEditorExpanded(false);setSkillOpen(false);setSettingsOpen(false);setMentionOpen(false);
    if(url.pathname===videoPath&&url.searchParams.has('group')||url.pathname===imagePath&&url.searchParams.has('tool')){setSelectedJobId('editing');setPreviewTab('预览');}
    if(next==='image'){setShowImageExample(true);setPreviewTab('预览');}
  }
  async function guardedNavigation(commit:()=>void){if(groupLeave.current&&!groupLeave.current())return false;const attempt=++navigationSequence.current;const leave=depthOpenRef.current?depthBeforeLeave.current:detailOpenRef.current?detailBeforeLeave.current:null;try{if(leave&&!await leave())return false;if(attempt!==navigationSequence.current)return false;commit();return true;}catch(error){showNotice('当前内容尚未保存：'+(error as Error).message);return false;}}
  function navigatePath(path:string){if(commerceInternalPath(path)==='/characters'){const prev=commerceInternalPath(workspacePath.current);roleReturn.current=prev.startsWith(videoPath)||prev.startsWith(imagePath)?prev:videoPath;}const browserPath=commerceBrowserPath(path);return guardedNavigation(()=>{applyWorkspacePath(path);if(window.location.pathname+window.location.search!==browserPath)window.history.pushState(null,'',browserPath);});}
  function openSkillDraft(text:string){const draft={id:'custom-'+crypto.randomUUID(),text};workspaceInputs.set(ownerKey+':new-skill',JSON.stringify(draft));void navigatePath('/skills?view=save');}
  async function openMemberChat(id?:string){
    const conversation=id||crypto.randomUUID();
    if(!await navigatePath('/agent-chat?conversation='+encodeURIComponent(conversation)))return;
    setConversationId(conversation);
    if(!id){setPrompts(previous=>({...previous,agent:''}));clearMaterials('agent');}
  }
  async function renameMemberChat(id:string,title:string){
    try{await api('/api/commerce/conversations',{id,title},'PATCH');await runtime.refresh();}
    catch(error){showNotice((error as Error).message);}
  }
  async function deleteMemberChat(id:string){
    if(!window.confirm('删除这条会话记录？删除后不可恢复。'))return;
    try{
      await api('/api/commerce/conversations',{id},'DELETE');
      if(conversationId===id)setConversationId(crypto.randomUUID());
      await runtime.refresh();
    }catch(error){showNotice((error as Error).message);}
  }
  function navigate(next: CommerceTab) { const routes={home:'/',agent:'/agent-chat',video:'/toolbox/video-generation',image:'/toolbox/image-generation',canvas:'/canvas',assets:'/assets'};return navigatePath(routes[next]); }
  function navigateRail(next: CommerceTab) {
    return next==='video'?navigatePath(videoPath+'?scene='+sceneKeys['ecommerce-spoken-selling']+'&mode=director'):navigate(next);
  }
  function openSkill(skill: CommerceSkill) { if(blockPendingReferences('image'))return;setSelectedJobId('editing');setSkillOpen(false);imageSkillRef.current=skill.id;setSkillId(skill.id);setMaterialsFor('image',assignOpenImageSlots(materialRef.current.image,getImageInputContract(skill.id).slots));setShowImageExample(true);navigate('image');setSelectedDraft(''); }
  function homeInputReady(){
    if(!homeReady)return false;
    if(homeDocument.current.mentions.some(m=>m.status==='missing'||m.status==='unassigned')){showNotice('请删除失效的 @图片 引用并重新选择对应图片');return false;}
    return true;
  }
  function transferHome(kind:'agent'|'video'|'image'){
    const items=materialRef.current.home;
    if(!items.length&&!homeDocument.current.text.trim())return true;
    if(kind==='image'&&items.some(item=>!item.type.startsWith('image/'))){showNotice('图片创作仅接受图片素材，请移除其他类型或选择视频创作');return false;}
    if(blockPendingReferences(kind))return false;
    if(items.length){
      const imgSlot=imageSlotOrder()[0]||'reference';
      const next=items.map(item=>({...item,slot:kind==='image'?imgSlot:item.type.startsWith('audio/')?'sound':'reference'}));
      replaceEditorMaterials(kind,next);
      if(kind==='image')commitImageDocument(reconcileImageReferenceDocument(homeDocument.current,imageEditorReferences(next),imageSlotOrder()));
    }
    const text=homeDocument.current.text;
    if(text){
      const labels=items.filter(item=>item.type.startsWith('image/')).map((item,i)=>'@图片'+(i+1)+' 对应第 '+(items.indexOf(item)+1)+' 份参考素材（'+item.name+'）');
      const mapping=kind!=='image'&&homeDocument.current.mentions.length?'\n'+labels.join('\n'):'';
      setPrompts(v=>({...v,[kind]:text+mapping}));
    }
    return true;
  }
  const detailTransfer=useRef<{signature:string;requestId:string;busy:boolean}|null>(null);
  async function openHomeDetail(path:string){
    const items=materialRef.current.home, instruction=homeDocument.current.text;
    if(instruction.length>4000||items.length>5||items.some(item=>!item.type.startsWith('image/'))){showNotice('商详套图支持最多 5 张商品图片和 4000 字说明，请调整首页输入');return;}
    const signature=JSON.stringify([instruction,items.map(item=>item.id)]);
    if(detailTransfer.current?.busy)return;
    const operation={signature,requestId:detailTransfer.current?.signature===signature?detailTransfer.current.requestId:crypto.randomUUID(),busy:true};detailTransfer.current=operation;
    try{
      const references=[];
      for(const item of items){
        let id=item.serverId;
        if(!id){const response=await fetch(item.url);if(!response.ok)throw Error('无法读取商品图 '+item.name);const uploaded=await runtime.upload(new File([await response.blob()],item.name,{type:item.type}));id=uploaded.id;}
        references.push({id,slot:'reference'});
      }
      if(currentTab.current!=='home'||signature!==JSON.stringify([homeDocument.current.text,materialRef.current.home.map(item=>item.id)]))return;
      const result=await api<{session:{id:string}}>('/api/commerce/detail-sets',{action:'open',contextId:operation.requestId,references,instruction});
      if(currentTab.current==='home')await navigatePath(path+'?projectId='+encodeURIComponent(result.session.id));
    }catch(error){showNotice((error as Error).message);}finally{operation.busy=false;}
  }
  function chooseScenario(id:string) {
    const path=scenarioPath[id];if(!path||!homeInputReady())return;
    if(id==='detail'&&(materialRef.current.home.length||homeDocument.current.text.trim())){void openHomeDetail(path);return;}
    if(path===imagePath||path.startsWith(videoPath)){
      const kind=path===imagePath?'image':'video';
      if(!transferHome(kind))return;
      if(kind==='video'){const brief=homeDocument.current.text.trim();if(brief)workspaceInputs.set(ownerKey+':home-director-brief',brief);else workspaceInputs.delete(ownerKey+':home-director-brief');}
    }
    void navigatePath(path).then(opened=>{if(opened&&id==='image-create'){setHomeImagePicker(true);setSkillOpen(true);}});setSelectedTemplate(null);
  }
  function clearMaterials(kind:CommerceTab=tab) { if(['image','video','agent'].includes(kind)){referenceRecovery.current.cancel(kind as RecoveryKind);if(kind==='video')assistRestorePending.current=false;refreshRecovery();}replaceEditorMaterials(kind,[]); }
  function openUpload(slot: MaterialSlot) { if(blockPendingReferences())return;inputSlot.current = slot; setPickerSlot(slot); }
  function usePickedAssets(assets:UIAsset[]){if(!pickerSlot||blockPendingReferences())return;const target:CommerceTab=extraView==='characters'?(roleReturn.current.startsWith(imagePath)?'image':'video'):tab==='assets'?(assets.every(asset=>asset.type.startsWith('image/'))?'image':'video'):tab;if(blockPendingReferences(target))return;const accepted:UIAsset[]=[];const limits=target==='video'?(videoReferenceLimits||genericVideoReferenceLimits):undefined;for(const asset of assets){const issue=selectionError(materialGroups[target],accepted,asset,pickerSlot,limits);if(issue){showNotice(issue);return;}accepted.push(asset);}setMaterialsFor(target,current=>[...current,...accepted.map(asset=>({id:crypto.randomUUID(),serverId:asset.id,name:asset.name,type:asset.type,size:asset.size,url:asset.url,slot:pickerSlot.id}))]);setPickerSlot(null);if(extraView==='characters')void navigatePath(roleReturn.current);else if(tab==='assets')navigate(accepted.every(asset=>asset.type.startsWith('image/'))?'image':'video');}
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
  function removeMaterial(id: string) { setMaterials(current => current.filter(item => { if (item.id === id) { if(!Object.entries(materialRef.current).some(([key,list])=>key!==tab&&list.some(m=>m.url===item.url)))URL.revokeObjectURL(item.url); return false; } return true; })); }
  useEffect(()=>{
    const reload=(event:StorageEvent)=>{if(event.key===ownerKey+':drafts')setDrafts(readDrafts(ownerKey));};
    window.addEventListener('storage',reload);return ()=>window.removeEventListener('storage',reload);
  },[ownerKey]);
  async function updateDrafts(change:(current:Draft[])=>Draft[]){
    const key=ownerKey+':drafts';
    const write=()=>{const next=change(readDrafts(ownerKey,true));localStorage.setItem(key,JSON.stringify(next));setDrafts(next);};
    try{if(navigator.locks)await navigator.locks.request(key,write);else write();return true;}
    catch{showNotice('草稿未能写入，请检查本浏览器中的草稿和可用空间。');return false;}
  }
  async function removeDrafts(ids:string[]){
    const chosen=new Set(ids),kind=mediaKind;
    if(!chosen.size||!window.confirm(chosen.size===1?'删除所选草稿？':'清空此列表中的 '+chosen.size+' 份草稿？'))return;
    if(await updateDrafts(current=>current.filter(item=>item.kind!==kind||!chosen.has(item.id)))){
      if(chosen.has(selectedDraft))setSelectedDraft('');
      showNotice('已移除所选草稿。');
    }
  }
  async function saveDraft(kind: Draft['kind'] = mediaKind as Draft['kind']) {
    if (!prompt.trim() && !materials.length && !(kind==='video'&&helperMode) && !(kind === 'agent' && product.name.trim())) { showNotice('请先填写创作要求或添加参考素材。'); return; }
    if(blockPendingReferences(kind))return;
    const title = kind === 'image' ? selectedSkill.name : kind === 'video' ? sceneCard?.name||(directorSpec.default ? '视频创作' : directorSpec.name) : scenario.name;
    const draft: Draft = { id: crypto.randomUUID(), title, kind, prompt, skillId, createdAt: Date.now(), modelId:modelIds[kind]||'', aspectRatio, resolution, format, duration,...(kind==='image'?{imageReferenceDocument:imageDocumentRef.current,imageQuality}:{}), materials: materials.map(({ id, name, type, slot,serverId }) => ({ id, name, type, slot,serverId })), ...(kind === 'agent' ? { agent: { scenarioId, product: { ...product }, panels: [...panels], confirmed: planConfirmed } } : {}), ...(kind === 'video' ? { director,scriptSourceJobId,assistApplication:currentAssistApplication||undefined,directorApplication:currentDirectorApplication||undefined,helperConversationId,helperMode,helperPrompt,scriptLanguage,scriptDuration,generateAudio:videoGenerateAudio } : {}) };
    if (await updateDrafts(current=>{draft.number=Math.max(0,...current.filter(item=>item.kind===kind).map(item=>item.number||0))+1;return [draft,...current].slice(0,80);})) { setSelectedDraft(draft.id); showNotice('创作要求与素材引用已保存到带货项目的本浏览器草稿。'); }
  }
  async function restoreDraft(draft:Draft){
    if(!startEditorRecovery(draft))return;
    setSelectedDraft(draft.id);setSelectedJobId('editing');setPreviewTab('预览');setShowImageExample(true);
    if(draft.kind==='video'&&draft.helperMode&&draft.director){
      const brief=draft.director.startsWith('brief:')?draft.director.slice(6):'',scene=isDirectorScene(brief)?brief:sceneKeys[draft.director];
      if(scene){appliedRouteScene.current=scene+'||director|';await navigatePath(videoPath+'?scene='+encodeURIComponent(scene)+'&mode=director');return;}
    }
    if(draft.kind==='image'&&imageKeys[draft.skillId]){await navigatePath(imagePath+'?tool='+encodeURIComponent(imageKeys[draft.skillId]));return;}
    await navigate(draft.kind);
  }
  function exportDraft(draft: Draft) { downloadText(`${draft.title}.json`, JSON.stringify({ ...draft, stage: 'draft', generated: false }, null, 2)); }
  function favorite(id: string) { const next = favoriteIds.includes(id) ? favoriteIds.filter(value => value !== id) : [...favoriteIds, id]; try { localStorage.setItem(`${ownerKey}:favorites`, JSON.stringify(next)); setFavoriteIds(next); } catch { showNotice('收藏保存失败。'); } }
  function goTool(index: number) { if (index === 0) void navigate('canvas'); else if (index === 6) openSkill(imageSkills.find(item => item.id === 'image-refine')!); else { const paths:Record<number,string>={1:'/toolbox/video-editor',2:'/toolbox/video-quality-enhance',3:'/toolbox/video-watermark-remove',4:'/toolbox/video-subtitle-erase',5:'/toolbox/video-face-mosaic',8:'/toolbox/hot-video-remix',9:'/toolbox/voice-synthesis'};void navigatePath(paths[index]); } }
  function toggleDirectorNav() { setDirectorNavCollapsed(current => { const next = !current; try { localStorage.setItem(ownerKey+':scene-collapsed', next ? '1' : '0'); } catch {} return next; }); }
  function homeQuickTool(item:(typeof HOME_QUICK_TOOLS)[number]){if(item.action==='roles'){void navigatePath('/assets?tab=roles');return;}if(item.tool!==undefined)goTool(item.tool);}
  useEffect(()=>()=>{const recognition=voiceRecognition.current;if(recognition){recognition.onresult=null;recognition.stop();}},[tab,helperConversationId,helperMode]);
  function toggleVoiceInput(toDirector=false) { if (voiceRecognition.current) { voiceRecognition.current.stop(); return; } const speech = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }; const Recognition = speech.SpeechRecognition || speech.webkitSpeechRecognition; if (!Recognition) { showNotice('当前浏览器不支持语音输入，请直接输入文字。'); return; } const recognition = new Recognition(); recognition.lang = 'zh-CN'; recognition.interimResults = false; recognition.continuous = false; recognition.onresult = event => { const text = Array.from(event.results).map(result => result[0]?.transcript || '').join(''); if (text) { if(toDirector)setHelperPrompt(current=>(current+text).slice(0,8000));else setPrompt(current=>(current+text).slice(0,tab==='video'?12000:tab==='image'?Math.max(imagePromptLimit,current.length):10000)); } }; recognition.onerror = () => showNotice('语音输入未完成，请重试或直接输入文字。'); recognition.onend = () => { voiceRecognition.current = null; setListening(false); }; voiceRecognition.current = recognition; setListening(true); try { recognition.start(); } catch { voiceRecognition.current = null; setListening(false); showNotice('语音输入未能启动，请直接输入文字。'); } }
  const loadComposerLibrary=()=>api<SkillLibrary>('/api/commerce/studio/skills');
  function uploadComposerFile(){
    if(blockPendingReferences())return;
    inputSlot.current={id:'reference',label:'参考素材',min:0,max:12,kinds:['image','video','audio']};
    materialInput.current?.click();
  }
  function openComposerLibrary(){
    openUpload({id:'reference',label:'参考素材',min:0,max:12,kinds:['image','video','audio']});
  }
  function openConnector(name:string){void navigatePath('/skills?view=connectors&service='+encodeURIComponent(name))}
  function useChatSkill(skill:MemberSkill,thread=conversationId){
    const query=new URLSearchParams();
    if(thread)query.set('conversation',thread);
    if(!skill.instruction)query.set('skill',skill.id);
    void navigatePath('/agent-chat?'+query.toString()).then(opened=>{
      if(opened&&skill.instruction)setPrompts(v=>({...v,agent:[v.agent,skill.name+'\n'+skill.instruction].filter(Boolean).join('\n\n')}));
    });
  }
  async function prepareHome() {
    if(homeSkill){
      try{
        const lib=await loadComposerLibrary();
        const skill=[...lib.custom,...builtinSkills].find(s=>s.id===homeSkill.id&&lib.installed.includes(s.id));
        if(!skill){showNotice('所选技能已卸载，请移除后重新选择');return}
        if(!homeInputReady()||!transferHome('agent'))return;
        if(!prompt.trim())setPrompts(v=>({...v,agent:''}));
        if(!materials.length)clearMaterials('agent');
        useChatSkill(skill,crypto.randomUUID());
      }catch(e){showNotice((e as Error).message)}
      return;
    } if (!prompt.trim() && !materials.length) { showNotice('描述一下你想创作的内容，或先添加参考素材。'); return; } if(!homeInputReady()||!transferHome(homeMode))return;if(homeMode==='video'){setScriptSourceJobId('');setHelperMode(false);setHelperConversationId(crypto.randomUUID());}void navigate(homeMode); }
  const renderMaterial = (item: Material) => <div className="ca-material" key={item.id}>{item.type.startsWith('image/') ? <img src={item.url} alt={item.name} /> : item.type.startsWith('video/') ? <Video size={24} /> : <Music size={24} />}<button title={`移除 ${item.name}`} onClick={() => removeMaterial(item.id)}><X size={12} /></button><span title={item.name}>{item.name}</span>{tab==='image'&&<b className="ca-image-reference-number">@图片{imageEditingReferences().findIndex(value=>value.instanceId===item.id)+1}</b>}</div>;
  const inputMaterials = <>{materials.map(renderMaterial)}<button className="ca-attach" title="添加参考素材" onClick={() => openUpload({ id: 'reference', label: '参考素材', min: 0, max: 9, kinds: ['image', 'video', 'audio'] })}><Plus size={25} /></button></>;
  const currentModelStatus=mediaKind==='image'&&imageExecutionIssue?`可选择配置 · ${imageExecutionIssue}`:mediaKind==='video'&&!modelsLoading.video&&!model&&models.video.length?'当前素材或设置没有兼容模型':model?.generationReady===false?`可选择配置 · ${model.readinessMessage||'生成待验收'}`:model?.generationReady===true?'主站配置已启用，可执行':'';
  const geminiFlagshipProfile=modelCatalogs.image.curatedProfiles.find(profile=>/gemini\s*3\s*pro|nano\s*banana\s*pro/i.test(`${profile.label} ${profile.id}`));
  let missingInput='';
  if(tab==='image'){try{validateImageInput({skillId,prompt,format,references:materials.map(m=>({id:m.serverId||m.id,slot:m.slot}))},materials.map(m=>({id:m.serverId||m.id,type:m.type})));}catch(error){missingInput=(error as Error).message;}}
  else if(tab==='video'&&!helperMode&&!prompt.trim())missingInput='请填写视频创作要求';
  // 图片生成按钮实时预估价：复用服务端同一套定价（不落库、不锁定报价），素材未上传完成或校验未过时回退为“生成前确认”。
  const [imageEstimate,setImageEstimate]=useState<{key:string;price:number}|null>(null);
  const materialsSignature=JSON.stringify(materials.map(m=>[m.serverId||m.id,m.slot]));
  useEffect(()=>{
    if(tab!=='image'||!model||!modelIds.image||!!missingInput||!!imageModelCapabilityIssue||!!imageExecutionIssue){setImageEstimate(null);return;}
    if(materials.some(m=>!m.serverId&&!m.url.startsWith('/api/commerce/assets/'))){setImageEstimate(null);return;}
    const input={kind:'image',modelId:modelCatalogs.image.userSelectable?modelIds.image:undefined,prompt,skillId,aspectRatio,resolution,format,imageQuality:effectiveImageQuality,references:materials.map(m=>({id:m.serverId||m.id,slot:m.slot}))};
    const key=JSON.stringify(input);
    if(imageEstimate?.key===key)return;
    const timer=setTimeout(()=>{
      api<{quote:{payableTotal:number}}>('/api/commerce/quotes?estimate=1',input)
        .then(d=>setImageEstimate(current=>current?.key===key?current:{key,price:d.quote.payableTotal}))
        .catch(()=>setImageEstimate(current=>current?.key===key?null:current));
    },600);
    return()=>clearTimeout(timer);
  },[tab,model?.id,modelIds.image,missingInput,imageModelCapabilityIssue,imageExecutionIssue,materialsSignature,prompt,skillId,aspectRatio,resolution,format,effectiveImageQuality]);
  // 视频生成按钮实时预估价：与提交同一报价链路（estimate=1 不落库、不锁定报价），校验未过时回退为“生成前确认”。
  const [videoEstimate,setVideoEstimate]=useState<{key:string;price:number}|null>(null);
  useEffect(()=>{
    if(tab!=='video'||helperMode||!model||!modelIds.video||!!missingInput||!!applicationCapabilityIssue||!videoQueryCurrent||model.generationReady!==true){setVideoEstimate(null);return;}
    if(materials.some(m=>!m.serverId&&!m.url.startsWith('/api/commerce/assets/'))){setVideoEstimate(null);return;}
    const input={kind:'video',modelId:modelCatalogs.video.userSelectable?modelIds.video:undefined,prompt,aspectRatio,resolution,duration,generateAudio:videoAudioToggleSupported?videoGenerateAudio:undefined,assistApplicationId:currentAssistApplication?.id,directorApplicationId:currentDirectorApplication?.id,parentJobId:scriptSourceJobId||undefined,references:materials.map(m=>({id:m.serverId||m.id,slot:m.slot}))};
    const key=JSON.stringify(input);
    if(videoEstimate?.key===key)return;
    const timer=setTimeout(()=>{
      api<{quote:{payableTotal:number}}>('/api/commerce/quotes?estimate=1',input)
        .then(d=>setVideoEstimate(current=>current?.key===key?current:{key,price:d.quote.payableTotal}))
        .catch(()=>setVideoEstimate(current=>current?.key===key?null:current));
    },600);
    return()=>clearTimeout(timer);
  },[tab,helperMode,model?.id,model?.generationReady,modelIds.video,missingInput,applicationCapabilityIssue,videoQueryCurrent,materialsSignature,prompt,aspectRatio,resolution,duration,videoGenerateAudio,videoAudioToggleSupported,currentAssistApplication?.id,currentDirectorApplication?.id,scriptSourceJobId]);
  const modelProblem=modelCatalogs[mediaKind].error||applicationCapabilityIssue||(mediaKind==='image'?(imageModelCapabilityIssue||imageExecutionIssue):model?.generationReady===false?model.readinessMessage||'当前模型暂不可生成':'');
  const modelDetails=<>{modelCatalogs[mediaKind].error&&<p role="alert" className="ca-muted">{modelCatalogs[mediaKind].error}</p>}{tab==='image'&&geminiFlagshipProfile&&geminiFlagshipProfile.status!=='selectable'&&<p role="status" data-testid="commerce-image-gemini-flagship-status" className="ca-model-planned"><strong>Gemini 3 Pro Image（Nano Banana Pro）</strong><span>{geminiFlagshipProfile.statusMessage||'旗舰模型待接入、待验收，当前不进入可选列表。'}</span></p>}{tab==='image'&&imageModelCapabilityIssue&&<p role="alert" data-testid="commerce-image-model-boundary" className="ca-muted">{imageModelCapabilityIssue}</p>}{tab==='image'&&imageExecutionIssue&&<p role="status" data-testid="commerce-image-model-status" className="ca-model-readiness">配置可选，生成待验收：{imageExecutionIssue}</p>}{tab==='video'&&model?.generationReady===false&&<p role="status" className="ca-model-readiness">{model.readinessMessage||'当前模型生成验收中；可先选择和配置，提交时仍会核验。'}</p>}{applicationCapabilityIssue&&<p role="alert" className="ca-muted">{applicationCapabilityIssue}</p>}</>;
  const modelSelect = <button className="ca-model-select" data-popover-trigger data-testid={`commerce-${mediaKind}-model-trigger`} aria-label={mediaKind==='image'?'选择图片模型':'选择视频模型'} aria-expanded={modelOpen} title={currentModelStatus||undefined} onClick={()=>{setModelOpen(!modelOpen);setSettingsOpen(false);}}><VideoTriggerIcon name={mediaKind==='video'?model?.displayName:undefined}/><span>模型<strong>{model?.displayName||(modelsLoading[mediaKind]?'正在读取模型…':'暂无可选择模型')}</strong></span><ChevronDown size={13}/></button>;
  const directorMaterials=directorSlots.map(value=>{
    const slot=slotFromObserved(value), selected=materials.filter(item=>item.slot===slot.id);
    if(actorSlot&&!nativeActor&&(slot.id===actorSlot.key||slot.id===sceneCharacterSlot)){
      const sibling=slot.id===sceneCharacterSlot?actorSlot.key:sceneCharacterSlot;
      slot.max=Math.min(slot.max,actorSlot.max-materials.filter(item=>item.slot===sibling).length);
    }
    const optionalImage=slot.id===productSlot?.key&&productMinimum===0;
    return <div className="ca-director-slot" data-optional-image={optionalImage||undefined} key={slot.id}><div>
      {selected.map(renderMaterial)}
      {selected.length<slot.max&&<button type="button" className="ca-director-add" aria-label={'添加'+slot.label} title={'添加'+slot.label} onClick={()=>{
        if(slot.label==='角色')setPickerCollection('roles');
        openUpload(slot);
      }}><span className="ca-director-thumb"><img src={slot.label==='角色'&&(!value.cover||value.cover===PUBLIC_UI.upload)?'/commerce/director-role-upload.png':value.cover||PUBLIC_UI.upload} alt=""/><Upload size={12} className="ca-director-upload-badge"/></span><span>添加{slot.label}{slot.min===0&&(slot.label==='角色'||slot.label==='声音')&&<span className="cs-director-optional"> (可选)</span>}</span></button>}
    </div></div>;
  });

  const isStudioHome=tab==='home'&&!hotRemixOpen&&!voiceOpen&&!extraView;
  const pendingReferences=['image','video','agent'].includes(tab)?referenceRecovery.current.get(tab as RecoveryKind):undefined;
  const recoveryPanel=pendingReferences&&<div className="ca-muted" role={pendingReferences.status==='loading'?'status':'alert'} aria-label="参考素材恢复"><strong>{pendingReferences.status==='loading'?'正在恢复参考素材':pendingReferences.status==='paused'?'素材恢复已暂停':'参考素材恢复失败'}</strong><p>{pendingReferences.error||`已保留 ${pendingReferences.snapshot.materials.length} 个素材引用，恢复完成后可继续生成。`}</p><div className="ca-actions"><button disabled={pendingReferences.status==='loading'} onClick={()=>retryEditorRecovery(pendingReferences.kind)}>重试恢复素材</button><button onClick={()=>discardEditorRecovery(pendingReferences.kind)}>舍弃待恢复素材</button></div></div>;
  return <div className="commerce-root cs-studio" data-tab={tab} data-testid="commerce-workspace">
    {createRoleMethod&&<CharacterCreate method={createRoleMethod} runtime={runtime} close={()=>setCreateRoleMethod(null)} saved={()=>{setCreateRoleMethod(null);setRoleLibraryVersion(v=>v+1);}}/>}
    {pickerSlot&&<AssetPicker runtime={runtime} slot={pickerSlot} existing={materials} limits={tab==='assets'?genericVideoReferenceLimits:videoReferenceLimits} initialCollection={pickerCollection} composerPicker={tab==='home'||tab==='agent'} directorPicker={tab==='home'||tab==='agent'||tab==='image'||tab==='video'&&helperMode} subtitle={tab==='image'?`${pickerSlot.label}最多添加 ${pickerSlot.max} 个素材；图片最多 ${getImageInputContract(skillId).mediaMaxCount.image} 个`:undefined} libraryVersion={roleLibraryVersion} onCreateRole={setCreateRoleMethod} onSelect={usePickedAssets} onClose={()=>{setPickerCollection('assets');setPickerSlot(null);}}/>}
    <input ref={materialInput} hidden type="file" onChange={event => { addFiles(event.target.files); event.target.value = ''; }} />
    <aside className="ca-rail" data-workspace-sidebar hidden={utility==='剪辑台'}><a className="cs-rail-marketplace" href="/" onClick={()=>markSecondaryPageReturn()} title="返回应用广场" aria-label="返回自媒体操盘手应用广场"><ArrowLeft size={18}/></a><button type="button" className="cs-brand-home" aria-label="带货创作首页" onClick={()=>void navigate('home')}><img src="/brand/platform-logo-display-256.webp" alt="" width={26} height={26}/></button><nav aria-label="带货 Agent 导航">{MENU.map(({ key, name, Icon }) => key==='agent'?<RailNavigationPanel key={key} label={name} panelTitle="Agent" pinned={pinnedNav===key} onPin={()=>setPinnedNav(v=>v===key?'':key)} current={(!extraView&&tab==='agent')||(extraView==='skills'&&['market','connectors'].includes(skillView))} enabled={tab!=='agent'&&!extraView} history={runtime.conversations} go={()=>void navigate('agent')} openChat={id=>void openMemberChat(id)} openSkills={()=>void navigatePath('/skills?view=market')} onRenameChat={(id,title)=>void renameMemberChat(id,title)} onDeleteChat={id=>void deleteMemberChat(id)}><Icon size={20}/><span>{name}</span></RailNavigationPanel>:(key==='video'||key==='image')&&tab!==key?<RailNavigationPanel key={key} label={name} panelTitle={key==='image'?'AI 图片':'AI 视频'} enabled current={false} pinned={pinnedNav===key} onPin={()=>setPinnedNav(v=>v===key?'':key)} go={()=>void navigateRail(key)} content={<StudioScenes image={key==='image'} cards={directorCards} active="" group="" embedded go={path=>void navigatePath(path)} collapse={()=>setPinnedNav('')} error={directorCatalogIssue} retry={()=>setCatalogAttempt(n=>n+1)}/>}>
        <Icon size={20}/><span>{name}</span></RailNavigationPanel>:key==='image'?<ImageRailMenu key={key} active={tab===key&&!utility&&!detailOpen&&!depthOpen&&!hotRemixOpen&&!voiceOpen} routeKey={workspacePath.current} onNavigate={navigatePath} onError={showNotice}><Icon size={20}/><span>{name}</span></ImageRailMenu>:<button key={key} title={name} aria-label={name} className={(!extraView && tab === key) && !utility && !detailOpen && !depthOpen && !hotRemixOpen && !voiceOpen ? 'active' : ''} onClick={() => navigateRail(key)} aria-current={(!extraView && tab === key) && !utility && !detailOpen && !depthOpen && !hotRemixOpen && !voiceOpen ? 'page' : undefined}><Icon size={20} /><span>{name}</span></button>)}</nav><div className="ca-rail-bottom"><RailAdminLink/><RailMore openSkills={()=>void navigatePath('/skills?view=market')} openSceneSkills={()=>void navigatePath('/skills')} toggleScenes={!utility&&!extraView&&!detailOpen&&!depthOpen&&!hotRemixOpen&&!voiceOpen&&['home','video','image'].includes(tab)?()=>tab==='home'?setHomeNav(!homeNav):toggleDirectorNav():undefined}/><RailWallet amount={memberCashBalance}/><RailLogin account={railAccount} /><RailAvatar account={railAccount} amount={memberCashBalance}/></div></aside>{pinnedNav&&<div className="cs-flyout-spacer" aria-hidden="true"/>}
    {!utility&&!extraView&&!detailOpen&&!depthOpen&&!hotRemixOpen&&!voiceOpen&&((tab==='home'&&homeNav)||(tab==='image'||tab==='video')&&!directorNavCollapsed)&&<StudioScenes image={tab==='image'&&!detailOpen} cards={directorCards} active={storyboardOpen?Object.keys(sceneKeys).find(key=>sceneKeys[key]===studioScene)||'':groupBuyOpen?groupBuyScene:tab==='image'?skillId:sceneCard?.key||directorSpec.key} group={studioGroup} collapse={()=>tab==='home'?setHomeNav(false):toggleDirectorNav()} go={path=>void navigatePath(path)} error={directorCatalogIssue} retry={()=>setCatalogAttempt(n=>n+1)}/>}
    <div className="ca-content">
      {isStudioHome&&<StudioHome cashBalance={memberCashBalance} ready={homeReady} restoreError={homeLoadError} retry={()=>setHomeAttempt(v=>v+1)} images={materialGroups.home.filter(m=>m.type.startsWith('image/'))} missing={homeDocument.current.mentions.some(m=>m.status==='missing')} prompt={prompt} change={setPrompt} chosen={homeSkill} chooseSkill={setHomeSkill} upload={uploadComposerFile} manage={()=>void navigatePath('/skills?view=market')} connector={openConnector} loadLibrary={loadComposerLibrary} listening={listening} mic={()=>toggleVoiceInput()} hasAssets={!!materials.length} attachments={materials.map(renderMaterial)} attach={openComposerLibrary} submit={prepareHome} choose={chooseScenario} quick={homeQuickTool}>
        <DiscoveryGallery ownerKey={ownerKey} onApply={applyUserPrompt} onNavigateCanvas={id=>navigatePath('/canvas?open='+encodeURIComponent(id))} onNotice={showNotice}/>
      </StudioHome>}
      {extraView==='skills'&&<SkillDirectory key={ownerKey+':'+skillView} marketEntry={skillView==='market'||skillView==='connectors'} connectorEntry={skillView==='connectors'} history={runtime.conversations} openChat={id=>{void navigate('agent').then(opened=>{if(!opened)return;setConversationId(id||crypto.randomUUID());if(!id){setPrompts(old=>({...old,agent:''}));clearMaterials('agent');}});}} draft={skillDraft} startCreation={()=>{void navigatePath('/agent-chat?view=create-skill').then(opened=>{if(opened){setConversationId(crypto.randomUUID());setPrompts(v=>({...v,agent:'请帮我创建一个创作技能。先询问我想解决的任务、要提供的素材，以及最终需要交付什么，再把确认的步骤写成一份可以保存和复用的创作指令。'}));}});}} cards={directorCards} go={path=>void navigatePath(path)} apply={skill=>{if(!skill.instruction){void navigatePath('/agent-chat?skill='+encodeURIComponent(skill.id)).then(opened=>{if(opened)setConversationId(crypto.randomUUID());});return;}if(skill.instruction){const text=skill.name+'\n'+skill.instruction;void navigate('agent').then(opened=>{if(opened)setPrompts(v=>({...v,agent:[v.agent,text].filter(Boolean).join('\n\n')}));});}}}/>}
      {extraView==='characters'&&<RoleDirectory manage={()=>{setPickerCollection('roles');openUpload({id:roleReturn.current.startsWith(imagePath)?imageSlotOrder()[0]||'reference':'reference',label:'角色',min:0,max:9,kinds:['image']});}} apply={asset=>{const kind=roleReturn.current.startsWith(imagePath)?'image':'video',slot=kind==='image'?imageSlotOrder()[0]||'reference':'reference';if(blockPendingReferences(kind))return;setMaterialsFor(kind,current=>current.some(v=>v.serverId===asset.id&&v.slot===slot)?current:[...current,{id:crypto.randomUUID(),serverId:asset.id,name:asset.name,url:asset.url,type:asset.type,size:asset.size,slot}]);void navigatePath(roleReturn.current);}}/>}
      {storyboardOpen&&isDirectorScene(studioScene)&&<SceneStoryboard key={ownerKey+studioScene} recovery={recoveryPanel} ready={editorRestored&&!pendingReferences} scene={studioScene} ownerKey={ownerKey} go={path=>void navigatePath(path)} useScript={(script,seconds)=>{if(blockPendingReferences('video'))return;void navigatePath(videoPath).then(opened=>{if(!opened)return;exitDirector();setDirectorApplication(null);setAssistApplication(null);setPrompts(old=>({...old,video:script}));setDuration(seconds);setSelectedJobId('editing');setPreviewTab('预览');});}}/>}
      {groupBuyOpen&&<GroupBuyEditor key={studioProjectId} initialId={studioProjectId} initialBrief={prompts.video} leaveGuard={groupLeave} initialImages={materialGroups.video.filter(m=>m.type.startsWith('image/')&&m.serverId).map(m=>m.serverId!)} onNavigate={path=>void navigatePath(path)}/>}
      {referenceProjectOpen&&(!hotRemixOpen||!!studioMode||!!studioProjectId)&&<ReferenceProjectEntry key={studioProjectId+':'+studioMode} approach={studioMode==='original'?'original':'shots'} initialProjectId={studioProjectId} onBatch={()=>void navigatePath('/toolbox/hot-video-remix?mode=batch')} runtime={runtime} onCanvas={id=>void navigatePath('/canvas?open='+encodeURIComponent(id))} onClose={()=>{if(!assistApplying)void navigate(hotRemixOpen?'home':'video');}} onDepth={()=>void navigatePath('/toolbox/depth-video-clone')} onApply={(text,jobId,application)=>void applyAssistScript(text,jobId,application)}/>}
      {assistId&&<PromptAssist id={assistId} runtime={runtime} onCanvas={id=>{setAssistId('');void navigatePath('/canvas?open='+encodeURIComponent(id));}} onClose={()=>{if(!assistApplying)setAssistId('');}} onApply={(text,jobId,application)=>void applyAssistScript(text,jobId,application)}/>}
      {(tab === 'image' || tab === 'video') && !utility && !detailOpen && !depthOpen && !groupBuyOpen && !storyboardOpen && <div className={`ca-studio ${!queueOpen ? 'ca-studio-noqueue' : ''} ${editorExpanded?'ca-editor-expanded':''}`} data-kind={tab} data-mode={helperMode&&tab==='video'?'director':'direct'}>
        <section className="ca-editor">{groupDirectorKey&&(groupHandoff.key!==groupDirectorKey||groupHandoff.error)?<div className="ca-director-service-error" role="status">{groupHandoff.key===groupDirectorKey?groupHandoff.error:'正在读取所选团购资料和分镜…'}<button onClick={()=>void navigatePath(videoPath+'?scene='+groupBuyScene+'&projectId='+encodeURIComponent(studioProjectId))}>返回团购项目</button></div>:<><div className="ca-editor-heading" data-picker-open={inlinePicker||undefined}><button data-popover-trigger onClick={() => tab === 'image' ? setSkillOpen(!skillOpen) : setDirectorOpen(!directorOpen)}><span className="ca-tool-avatar"><img src={tab === 'image' ? imageSpec?.icon||'/commerce/image-icon.png' : groupDefault?.icon||sceneCard?.icon||directorSpec.icon||'/commerce/video-icon.png'} alt=""/></span><span><strong>{tab === 'image' ? selectedSkill.name : groupDefault?.name||sceneCard?.name||(directorSpec.default ? '视频创作' : directorSpec.name)}</strong>{(tab==='image'&&skillId!=='default'||tab==='video'&&(helperMode||!directorSpec.default||sceneCard||groupDefault))&&<small>{tab==='image'?imageSpec?.description||selectedSkill.description:groupDefault?.description||sceneCard?.description||directorSpec.description}</small>}</span><ChevronRight size={17} /></button>{inlinePicker?<button className="ca-inline-clear" onClick={clearPickerSelection}>清除选择</button>:<>{tab==='video'&&(helperPrompt.trim()||materials.length>0||prompts.video.trim())&&<button title="保存当前草稿" onClick={()=>saveDraft('video')}><Save size={15}/></button>}{tab==='image'&&(prompt.trim()||materials.length>0)&&<button type="button" className="ca-save-image-draft" aria-label="保存草稿" title="保存待执行草稿" onClick={()=>saveDraft('image')}><Save size={15}/></button>}<button className="ca-new" onClick={newEditor}>＋ 新建</button></>}</div>
          {recoveryPanel}
          {skillOpen&&tab==='image'&&<CreationPicker kind="image" inline={inlinePicker} selected={skillId} onClear={clearPickerSelection} onClose={()=>setSkillOpen(false)} items={imageSkills.filter(i=>i.id!=='default'&&!i.canvasOnly).map(i=>({id:i.id,name:i.name,description:observedImage(i.name)?.description||i.description,...(()=>{const p=observedImage(i.name);return {category:p?.category||i.category,icon:p?.icon,recommended:p?.recommended,order:p?.order};})()}))} onPick={id=>openSkill(imageSkills.find(i=>i.id===id)!)}/>}
          {directorOpen&&tab==='video'&&<CreationPicker kind="video" inline={inlinePicker} initialCategory={pickerGroupName} selected={groupDefault?.key||(helperMode?sceneCard?.key||directorSpec.key:undefined)} onClear={clearPickerSelection} onClose={()=>setDirectorOpen(false)} items={visibleSceneCards(directorCards).map((card,i)=>{const index=DIRECTORS.findIndex(d=>d.key===card.key);return {id:card.key,...card,order:index<0?DIRECTORS.length+i:index};})} onPick={key=>{setDirectorOpen(false);void navigatePath(videoPath+'?scene='+encodeURIComponent(sceneKeys[key]||key)+'&mode=director');}}/>}
          {helperMode&&tab==='video'&&!activeDirector?<p role="status">当前编导暂不可用，请从侧栏选择已启用的编导。</p>:helperMode&&tab==='video'?<DirectorPanel runtime={runtime} sceneTask={sceneTask} missingSceneImage={missingDirectorImage} referenceSignature={JSON.stringify(materials.map(m=>[m.id,m.slot]))} onMic={()=>toggleVoiceInput(true)} listening={listening} sceneTools={isDirectorScene(studioScene)?<div className="cs-scene-actions"><button type="button" onClick={()=>void navigatePath(videoPath+'?scene='+studioScene+'&mode=storyboard')}>编排分镜</button></div>:studioScene===groupBuyScene?<div className="cs-scene-actions"><button type="button" onClick={()=>void navigatePath(videoPath+'?scene='+groupBuyScene)}>填写团购资料</button></div>:undefined} directorName={directorSpec.key} directorSpec={directorSpec} getReferences={async()=>{const instances=materials.map(item=>item.id);return (await references()).map((ref,index)=>({...ref,...(actorSlot&&(ref.slot===sceneCharacterSlot||ref.slot===actorSlot.key&&actorSlot.label==='角色')?{slot:actorSlot.key,sceneRole:'character' as const}:{}),instanceId:instances[index]}));}} videoSettings={{aspectRatio:aspectRatios.video,resolution:resolutions.video,duration:scriptDuration,generateAudio:videoGenerateAudio}} onApplied={application=>void applyDirectorScript(application)} conversationId={helperConversationId} prompt={helperPrompt} setPrompt={setHelperPrompt} onSend={()=>void sendChat(true)} onExit={exitDirector} onUse={(text,jobId)=>{setHelperMode(false);setScriptSourceJobId(jobId||'');setPrompt(text);setMaterials(current=>current.map(m=>({...m,slot:m.type.startsWith('audio/')?'sound':'reference'})));const options=models.video.find(m=>modelSelectionId(m)===modelIds.video||m.id===modelIds.video)?.capabilities.nativeDurations;if(Array.isArray(options)&&options.includes(scriptDuration))setDuration(scriptDuration);else if(scriptDuration!==duration)showNotice('脚本已应用；请核对当前视频模型支持的时长。');}} materials={directorMaterials} hasMaterials={materials.length>0} language={scriptLanguage} setLanguage={setScriptLanguage} duration={scriptDuration} setDuration={setScriptDuration}/>:<>
          <div className="ca-prompt-box" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); addFiles(event.dataTransfer.files, slots[0]); }}><div className="ca-input-toolbar"><span>{materials.filter(item => slots.some(slot => slot.id === sceneSeat(item))).length} / {tab === 'image' ? getImageInputContract(skillId).mediaMaxCount.image : 15}</span><div><UserPromptLibrary ownerKey={ownerKey} capture={captureUserPrompt} onApply={applyUserPrompt} onNotice={showNotice} toolbarIcons={tab==='image'?{save:<ImageEditorIcon kind="save"/>,library:<ImageEditorIcon kind="library"/>}:undefined}/>{tab!=='image'&&<><button title="素材库" onClick={() => openUpload(slots[0])}><FolderOpen size={14} /></button><button title="引用素材" onClick={() => setMentionOpen(!mentionOpen)}>＠</button></>}<button title={editorExpanded?"收起编辑区":"展开编辑区"} onClick={() => setEditorExpanded(!editorExpanded)}>{tab==='image'?<ImageEditorIcon kind="expand"/>:<Expand size={14} />}</button></div></div>
            <div className="ca-slots">{slots.map(slot => <div key={slot.id} className="ca-slot" data-slot={slot.id}><div className="ca-slot-files">{slotMaterials(slot).map(renderMaterial)}{slotMaterials(slot).length < slot.max && <button className="ca-slot-upload" title={`添加${slot.label}`} onClick={() => openUpload(slot)}><img src={tab==='image'?imageSpec?.slots[slots.indexOf(slot)]?.cover||PUBLIC_UI.upload:slot.kinds.includes('audio')?PUBLIC_UI.sound:PUBLIC_UI.upload} alt=""/><Upload size={12} /><span className="cs-upload-caption">添加{(tab==='image'?imageSpec?.slots[slots.indexOf(slot)]?.label||'图片':slot.label).replace(/^添加/,'')}</span></button>}</div><span>{tab==='image'?'添加'+(imageSpec?.slots[slots.indexOf(slot)]?.label||'图片')+(slot.min===0?'（可选）':''):(slot.label.startsWith('添加')?slot.label:'添加'+slot.label)+(slot.min>0?'':' (可选)')}</span><small>最多 {slot.max} 个</small></div>)}{tab==='video'&&!directorSceneActive&&<WorkspaceRoleUpload onOpen={()=>{setPickerCollection('roles');openUpload(slots[0]);}}/>}{tab==='image'&&skillId==='default'&&materials.length>0&&<button className="ca-add-more-reference" title="点击添加参考图片" onClick={()=>openUpload(slots[0])}><Plus size={24}/><small>点击添加</small></button>}</div>
            {materials.some(item => !slots.some(slot => slot.id === sceneSeat(item))) && <div className="ca-unassigned"><span>分配参考素材：</span>{materials.filter(item => !slots.some(slot => slot.id === sceneSeat(item))).map(item => <label key={item.id}>{item.name}<select aria-label={`分配${item.name}角色`} value="" onChange={event => { const target = slots.find(slot => slot.id === event.target.value); if (!target) return; if (materials.filter(value => value.slot === target.id).length >= target.max || !target.kinds.includes(fileKind(item.type) as 'image' | 'video' | 'audio')) { showNotice('该角色已满或不支持此素材类型。'); return; } setMaterials(current => current.map(value => value.id === item.id ? { ...value, slot: target.id } : value)); }}><option value="">选择角色</option>{slots.map(slot => <option key={slot.id} value={slot.id}>{slot.label}</option>)}</select></label>)}</div>}
            {tab==='video'&&canaryJobId&&<button type="button" disabled={!editorRestored||assistApplying} onClick={()=>void importCanaryDraft()}>应用验收稿件和参考素材</button>}
            <ImagePromptLine enabled={tab==='image'} skill={tab==='image'&&skillId!=='default'?<button className="ca-skill-chip" onClick={()=>setSkillOpen(true)}><ImageIcon size={14}/>{selectedSkill.name}</button>:undefined}>
            <textarea ref={tab==='image'?imageTextarea:undefined} onPaste={pasteImagePrompt} aria-label={tab === 'image' ? '图片创作要求' : '视频创作要求'} value={prompt} onChange={event => { setPrompt(event.target.value); if (event.target.value.endsWith('/')) setSkillOpen(tab === 'image'); if (event.target.value.endsWith('@')) setMentionOpen(true); }} maxLength={tab === 'image' ? imagePromptLimit : 12000} placeholder={tab === 'image' ? imageSpec?.hint||selectedSkill.description : '输入视频提示词，使用 @ 指定参考素材'} /></ImagePromptLine>
            {tab==='image'?<ImageReferenceControls document={imageDocument} references={imageEditingReferences()} slots={getImageInputContract(skillId).slots} showMenu={mentionOpen} textarea={imageTextarea.current} onChange={commitImageEditorEdit} onClose={()=>setMentionOpen(false)} onError={showNotice}/>:mentionOpen&&<div className="ca-mention-menu"><strong>引用参考素材</strong>{materials.length?materials.map(item=><button key={item.id} onClick={()=>{setPrompt(value=>`${value.replace(/@$/,'')}@${item.name} `);setMentionOpen(false);}}>{item.name}</button>):<p>请先添加参考素材。</p>}<button onClick={()=>setMentionOpen(false)}>收起</button></div>}
            <div className="ca-prompt-bottom"><span>{prompt.length} / {tab === 'image' ? imagePromptLimit : 12000}</span>{tab === 'image' && <button type="button" className="ca-image-mic" aria-label={listening?'停止语音输入':'语音输入'} aria-pressed={listening} onClick={()=>toggleVoiceInput()}><Mic size={16}/></button>}{tab === 'video' && <div className="ca-video-helper-actions"><details className="cs-video-tools"><summary aria-label="更多视频工具">···</summary><div><button onClick={()=>void openPromptAssist()}>帮我写</button><button onClick={()=>void navigatePath('/toolbox/video-generation?project=reference')}>拆解参考视频</button><button type="button" aria-label="上传原视频并替换人物、服装、商品或环境" onClick={()=>void navigatePath('/toolbox/depth-video-clone')}>复刻原视频</button></div></details><button type="button" aria-label={listening?'停止语音输入':'语音输入'} aria-pressed={listening} onClick={()=>toggleVoiceInput()}><Mic size={16}/></button><button onClick={() => chooseDirector(director)}><Sparkles size={13} />超级编导</button></div>}</div></div>
          {modelProblem&&<button type="button" className="cs-model-issue" title={modelProblem} onClick={()=>{setSettingsOpen(false);setModelOpen(true);}}>{modelProblem}</button>}
          <div className="ca-settings-row">{modelOpen&&<div className="ca-model-popover-host" data-testid={`commerce-${mediaKind}-model-list`}><ModelPopover imagePicker={mediaKind==='image'} routeOrder={mediaKind==='video'} items={pickerModels(models[mediaKind],mediaKind as ModelKind)} selected={modelIds[mediaKind]} onSelect={id=>setModelIds(current=>({...current,[mediaKind]:id}))} onClose={()=>setModelOpen(false)}>{modelDetails}</ModelPopover></div>}<div className="ca-parameter-anchor" data-testid={`commerce-${mediaKind}-model-picker`}>{modelSelect}</div><div className="ca-parameter-anchor">{settingsOpen&&<MediaSettings kind={tab==='video'?'video':'image'} capabilities={tab==='video'&&model?.memberResolutionOptions?.length?{...model.capabilities,resolutionOptions:model.memberResolutionOptions}:model?.capabilities||{}} memberBilling={tab==='video'&&!videoQueryCurrent?undefined:model?.memberBilling} compatibilityIssue={tab==='video'?applicationCapabilityIssue:undefined} aspectRatio={aspectRatio} resolution={resolution} format={format} duration={duration} generateAudio={videoGenerateAudio} onGenerateAudio={setVideoGenerateAudio} onRatio={setAspectRatio} onResolution={setResolution} onFormat={setFormat} imageQuality={effectiveImageQuality} onImageQuality={setImageQuality} onDuration={setDuration} onClose={()=>setSettingsOpen(false)}/>}<button data-popover-trigger data-testid={`commerce-${mediaKind}-settings-trigger`} aria-expanded={settingsOpen} onClick={() => {setSettingsOpen(!settingsOpen);setModelOpen(false);}}><SlidersHorizontal size={18} /><span>{tab === 'image' ? '图片设置' : '视频设置'}<strong>{aspectRatio} · {tab==='video'?resolution.toUpperCase():resolution} · {tab === 'image' ? [imageQualityLabel,nativeImageSize?`${nativeImageSize.width}×${nativeImageSize.height}`:null,format].filter(Boolean).join(' · ') : `${duration}s`}</strong></span><ChevronDown size={13} /></button></div></div>
          <div className="ca-generate-row"><button className="ca-primary" title={(tab==='video'&&(model?.modeIncompatibleReasons?.join('、')||(model?.generationReady===false&&model.readinessMessage)))||missingInput||undefined} disabled={!!missingInput||!runtime.ready||runtime.sending||assistApplying||!!referenceRecovery.current.get(mediaKind as RecoveryKind)||!!applicationCapabilityIssue||(tab==='image'&&(!model||!canConfigureModel(model)||!!imageModelCapabilityIssue||!!imageExecutionIssue))||(tab==='video'&&(!videoQueryCurrent||!model||model.modeCompatible===false||model.capabilities.available===false||model.generationReady===false))} onClick={()=>void generate()}>{runtime.sending?'提交中…':tab === 'image' ? '立即生成图片' : '立即生成视频'}<span>{tab==='video'&&model?.generationReady===false?'带货生成待验收':missingInput?'预计 -- 元':tab==='image'&&imageExecutionIssue?'配置可选，生成待验收':tab==='image'&&imageEstimate?'预计 ¥'+imageEstimate.price.toFixed(2):tab==='video'&&videoEstimate?'预计 ¥'+videoEstimate.price.toFixed(2):'生成前确认'}</span></button></div></>}
        </>}</section>
        <section className="ca-preview"><div className="ca-tabs">{['预览','收藏'].map(label=>{const name=label;return <button key={name} className={previewTab===name?'selected':''} onClick={()=>{setPreviewTab(name);}}>{label==='预览'&&!selectedJob&&(tab==='video'||showImageExample)?'参考示例':label}</button>;})}{!queueOpen&&<button className="ca-open-queue" onClick={()=>setQueueOpen(true)}>任务列表 <ChevronRight size={14}/></button>}</div>{previewTab==='预览'?(tab==='image'&&showImageExample&&!selectedJob?<ImageExample name={selectedSkill.name}/>:!selectedJob&&tab==='video'?<div className="cs-video-example"><h2>视频创作</h2><p>上传素材，用「<button type="button" onClick={()=>chooseDirector(director)}>超级编导</button>」一键成片</p><video className="cs-video-example-player" aria-label="视频创作参考示例" src="/commerce/video-creation-example.mp4" autoPlay muted playsInline loop preload="metadata" /></div>:<TaskPreview onNotice={showNotice} favorite={!!selectedJob&&favoriteIds.includes('job:'+selectedJob.id)} onFavorite={()=>selectedJob&&toggleJobFavorite(selectedJob.id)} job={selectedJob} onReuse={reuseJob} onRetry={()=>{if(selectedJob)void api('/api/commerce/jobs',{action:'retry-save',id:selectedJob.id}).then(()=>runtime.refresh()).catch(e=>showNotice(e.message));}}/>):<div className="cs-workspace-favorites">{(favoriteJobs.length>0||favoriteScenes.length>0)&&<div className="ca-reference-grid">{favoriteJobs.map(item=><button key={item.id} onClick={()=>{setSelectedJobId(item.id);setPreviewTab('预览');setShowImageExample(false);}}>{tab==='image'&&item.assetIds[0]?<img src={'/api/commerce/assets/'+item.assetIds[0]} alt=""/>:<Video size={28}/>}<span>{item.input.prompt.slice(0,42)||'创作结果'}</span></button>)}{favoriteScenes.map(item=><button key={item.id} onClick={()=>setSelectedTemplate(item)}><img src={item.image} alt=""/><span>{item.name}</span></button>)}</div>}<DiscoveryGallery ownerKey={ownerKey} favoritesOnly fixedKind={tab==='image'?'image':'video'} hasOtherFavorites={!!(favoriteJobs.length||favoriteScenes.length)} onApply={applyUserPrompt} onNavigateCanvas={id=>navigatePath('/canvas?open='+encodeURIComponent(id))} onNotice={showNotice}/></div>}</section>
        {queueOpen&&<TaskQueue selectedDraft={selectedJob?undefined:savedEditorDraft?.id} onRemoveDrafts={ids=>void removeDrafts(ids)} drafts={drafts.filter(draft=>draft.kind===mediaKind)} onSelectDraft={id=>{const draft=drafts.find(value=>value.id===id);if(draft)void restoreDraft(draft);}} editing={!savedEditorDraft&&(prompt.trim()||materials.length||helperMode&&helperPrompt.trim())?{selected:!selectedJob,onSelect:()=>{setSelectedJobId('editing');setPreviewTab('预览');setShowImageExample(true);}}:undefined} jobs={relevantJobs} selected={selectedJob?.id||''} onSelect={id=>{setSelectedJobId(id);setPreviewTab('预览');setShowImageExample(false);}} onClose={()=>setQueueOpen(false)}/>}
      </div>}

      {tab === 'agent' && recoveryPanel}
      {tab === 'agent' && extraView===''&&skillView==='create-skill'&&<button className="cs-save-skill" onClick={()=>openSkillDraft(prompts.agent)}>填写并保存技能</button>}
      {tab === 'agent' && <ChatPanel selectedSkill={agentSkill} removeSkill={()=>void navigate('agent')} openSkillWorkspace={path=>void navigatePath(path)} onSkills={()=>void navigatePath('/skills?view=market')} onConnectors={openConnector} chooseSkill={useChatSkill} loadLibrary={loadComposerLibrary} onAttach={openComposerLibrary} onUpload={uploadComposerFile} onMic={()=>toggleVoiceInput()} listening={listening} onSaveSkill={openSkillDraft} runtime={runtime} prompt={prompt} setPrompt={setPrompt} modelSelect={<><AgentPreferencePanel preferences={agentPrefs} models={preferenceModels} ready={prefsLoaded} pending={prefsSaving} onChange={changeAgentPreference}/><ChatWorkspaceMenu onCloseModel={closeChatModel}>{chatModelSelect}</ChatWorkspaceMenu></>} onSend={()=>void sendChat()} materials={materials.map(renderMaterial)} onNew={()=>void openMemberChat()} conversationId={conversationId} setConversationId={id=>void openMemberChat(id)} onUse={useChat}/>}

      {tab === 'canvas' && <CommerceCanvas runtime={runtime} ownerKey={ownerKey} detailTemplate={detailTemplate} panelTitles={panels} onReferenceProject={()=>void navigatePath('/toolbox/hot-video-remix')} onNotice={showNotice} />}

      {tab === 'assets' && <StudioLibrary view={libraryView} runtime={runtime} favorites={favoriteIds} useAsset={useAsset} go={path=>void navigatePath(path)} discovery={<DiscoveryGallery favoritesOnly ownerKey={ownerKey} onApply={applyUserPrompt} onNavigateCanvas={id=>navigatePath('/canvas?open='+encodeURIComponent(id))} onNotice={showNotice}/>} materials={<MemberAssets runtime={runtime} roles={libraryView==='roles'} onUse={useAsset} onNotice={showNotice} go={path=>void navigatePath(path)} manage={roles=>{setPickerCollection(roles?'roles':'assets');openUpload({id:'reference',label:roles?'角色':'参考素材',min:0,max:9,kinds:roles?['image']:['image','video','audio']});}}/>}/>} 

      {detailOpen && <DetailSetStudio runtime={runtime} onBeforeLeaveReady={registerDetailLeave} onClose={()=>navigate('home')} onNotice={showNotice}/>}
      {depthOpen && <DepthVideoCloneStudio key={studioMode==='elements'?'elements':'depth'} elementMode={studioMode==='elements'} ownerKey={ownerKey} go={path=>void navigatePath(path)} runtime={runtime} initialSessionId={depthSessionId||undefined} onBeforeLeaveReady={registerDepthLeave} onNotice={showNotice} onBack={()=>void navigate('home')} onOpenEditor={assetId=>void navigatePath('/toolbox/video-editor?assetId='+encodeURIComponent(assetId))}/>}
      {hotRemixOpen && !referenceProjectOpen && <HotVideoRemixStudio runtime={runtime} onNotice={showNotice} onBack={()=>void navigate('home')}/>}
      {voiceOpen && <VoiceSynthesisStudio onNotice={showNotice} onBack={()=>void navigate('home')}/>}
      {(utility==='剪辑台'||minimizedClip!==null)&&<div className="cs-clip-window" hidden={utility!=='剪辑台'}>
        <MediaTools ownerKey={ownerKey} key={utility==='剪辑台'?utilityAssetId:minimizedClip} name="剪辑台" runtime={runtime} initialAssetId={(utility==='剪辑台'?utilityAssetId:minimizedClip)||undefined} onNotice={showNotice}
          onBack={()=>{void navigate('home').then(moved=>{if(moved)setMinimizedClip(null);});}}
          onMinimize={()=>{setMinimizedClip(utilityAssetId);void navigate('home');}}/>
      </div>}
      {tab==='home'&&minimizedClip!==null&&<button type="button" className="cs-clip-resume" onClick={()=>void navigatePath('/toolbox/video-editor'+(minimizedClip?'?assetId='+encodeURIComponent(minimizedClip):''))}><Scissors size={16}/>展开剪辑台</button>}
      {utility&&utility!=='剪辑台'&&<MediaTools ownerKey={ownerKey} key={utility+':'+utilityAssetId} name={utility} runtime={runtime} initialAssetId={utilityAssetId||undefined} onNotice={showNotice} onBack={()=>navigate('home')}/>}
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
function readDrafts(key:string,strict=false):Draft[]{
  try{
    const value:unknown=JSON.parse(localStorage.getItem(key+':drafts')||'[]');
    if(!Array.isArray(value))throw Error('草稿格式无效');
    const items:Draft[]=value.filter(item=>item&&typeof item.id==='string'&&typeof item.title==='string'&&typeof item.prompt==='string'&&['image','video','agent'].includes(item.kind)&&Array.isArray(item.materials)).slice(0,80);
    if(strict&&items.length!==value.length)throw Error('草稿包含无法识别的记录');
    const numbers=new Map<string,number>();for(const d of [...items].reverse()){
      const previous=numbers.get(d.kind)||0;
      if(!Number.isSafeInteger(d.number)||Number(d.number)<1)d.number=previous+1;
      numbers.set(d.kind,Math.max(previous,d.number!));
    }
    return items;
  }catch(error){if(strict)throw error;return [];}
}
function downloadText(name: string, text: string) { const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
