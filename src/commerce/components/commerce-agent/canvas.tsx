'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, addEdge, useEdgesState, useNodesState, type Connection, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { FileText, Image as ImageIcon, Video, Plus, Save, Download, Trash2, Upload } from 'lucide-react';
import { DETAIL_PANELS, IMAGE_SKILLS } from './catalog';

type CanvasNode = Node<{ label: string; kind: string; prompt: string; skillId?: string }>;
type CanvasDocument = { version: 1; nodes: CanvasNode[]; edges: Edge[] };
const createNode = (kind: string, index: number): CanvasNode => ({ id: crypto.randomUUID(), position: { x: 70 + (index % 4) * 255, y: 90 + Math.floor(index / 4) * 180 }, data: { label: kind === 'image' ? '图片节点' : kind === 'video' ? '视频节点' : '文本节点', kind, prompt: '' }, style: { width: 200, minHeight: 90, borderRadius: 14, padding: 18, border: '1px solid #dce1e8', background: '#fff', color: '#202734' } });

export function CommerceCanvas({ ownerKey, detailTemplate, panelTitles, onNotice }: { ownerKey: string; detailTemplate: number; panelTitles: string[]; onNotice: (message: string) => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const initialized = useRef(false);
  const templateSeen = useRef(0);
  const key = `${ownerKey}:canvas`;
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const value = parseCanvas(raw);
        setNodes(value.nodes); setEdges(value.edges);
      }
    } catch { onNotice('画布草稿无法读取，可以重新导入导出的文件。'); }
    initialized.current = true;
  }, [key, onNotice, setEdges, setNodes]);
  const makeDetail = useCallback(() => {
    const source = { ...createNode('text', 0), id: crypto.randomUUID(), position: { x: 30, y: 250 }, data: { label: '商品资料', kind: 'text', prompt: '填写商品名称、已确认的卖点、规格、目标人群与参考素材说明。' } };
    const plan = { ...createNode('text', 1), position: { x: 280, y: 250 }, data: { label: '商详分屏计划', kind: 'text', prompt: '逐屏确认文案和视觉要求，再执行图片生成。' } };
    const screens = (panelTitles.length ? panelTitles : DETAIL_PANELS).map((title, index) => ({ ...createNode('image', index), position: { x: 560 + (index % 2) * 255, y: 45 + Math.floor(index / 2) * 170 }, data: { label: `${index + 1}. ${title}`, kind: 'image', prompt: `本屏用途：${title}。待补充商品事实和视觉要求。` } }));
    setNodes([source, plan, ...screens]);
    setEdges([{ id: crypto.randomUUID(), source: source.id, target: plan.id, label: '商品事实' }, ...screens.map(node => ({ id: crypto.randomUUID(), source: plan.id, target: node.id, label: '分屏要求' }))]);
    setSelected(source.id);
    onNotice('已建立可编辑的六屏商详画布，节点尚未执行生成。');
  }, [onNotice, panelTitles, setEdges, setNodes]);
  useEffect(() => { if (detailTemplate > 0 && detailTemplate !== templateSeen.current && initialized.current) { templateSeen.current = detailTemplate; makeDetail(); } }, [detailTemplate, makeDetail]);
  const connect = useCallback((connection: Connection) => { if (connection.source !== connection.target) setEdges(current => addEdge({ ...connection, label: '参考 / 指令' }, current)); }, [setEdges]);
  const active = nodes.find(node => node.id === selected);
  function save() {
    try { localStorage.setItem(key, JSON.stringify({ version: 1, nodes, edges })); onNotice('画布已保存到带货项目的本浏览器草稿。'); } catch { onNotice('浏览器空间不足，请导出画布文件保存。'); }
  }
  function exportDocument() {
    const blob = new Blob([JSON.stringify({ version: 1, nodes, edges }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = '带货Agent-画布.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importDocument(file?: File) {
    if (!file) return;
    try { if (file.size > 2_000_000) throw Error(); const value = parseCanvas(await file.text()); setNodes(value.nodes); setEdges(value.edges); setSelected(''); onNotice('画布已导入，请保存草稿。'); } catch { onNotice('画布文件格式无效，支持不超过 2 MB 的本模块 JSON 文件。'); }
  }
  return <div className="ca-canvas-page">
    <div className="ca-section-head"><div><h2>画布</h2><p>连接素材、文案、图片与视频，组织你的创作流程</p></div><div className="ca-actions"><button onClick={makeDetail}><Plus size={15} />商详套图</button><button onClick={save}><Save size={15} />保存草稿</button><button onClick={exportDocument}><Download size={15} />导出</button><button onClick={() => input.current?.click()}><Upload size={15} />导入</button><input ref={input} type="file" accept=".json,application/json" hidden onChange={event => { void importDocument(event.target.files?.[0]); event.target.value = ''; }} /></div></div>
    <div className="ca-canvas-tools">{[{ kind: 'text', label: '文本', Icon: FileText }, { kind: 'image', label: '图片', Icon: ImageIcon }, { kind: 'video', label: '视频', Icon: Video }].map(({ kind, label, Icon }) => <button key={kind} onClick={() => setNodes(current => [...current, createNode(kind, current.length)])}><Icon size={16} />添加{label}</button>)}<span>本浏览器草稿 · 拖动圆点连接节点</span></div>
    <div className="ca-canvas-body"><div className="ca-flow"><ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={connect} onNodeClick={(_, node) => setSelected(node.id)} onPaneClick={() => setSelected('')} fitView minZoom={0.2} maxZoom={2} deleteKeyCode={['Backspace', 'Delete']}><Background gap={22} color="#dfe4eb" /><Controls /><MiniMap pannable zoomable /></ReactFlow>{nodes.length === 0 && <div className="ca-canvas-empty"><ImageIcon size={36} /><h3>从一个想法开始</h3><p>添加节点，或打开商详套图模板。</p><button onClick={makeDetail}>使用商详套图模板</button></div>}</div><aside className="ca-node-inspector"><h3>{active ? '节点内容' : '选择一个节点'}</h3>{active ? <><label>名称<input value={active.data.label} onChange={event => setNodes(current => current.map(node => node.id === active.id ? { ...node, data: { ...node.data, label: event.target.value } } : node))} /></label>{active.data.kind === 'image' && <label>图片技能<select aria-label="画布图片技能" value={active.data.skillId || 'default'} onChange={event => setNodes(current => current.map(node => node.id === active.id ? { ...node, data: { ...node.data, skillId: event.target.value } } : node))}>{IMAGE_SKILLS.map(skill => <option key={skill.id} value={skill.id}>{skill.name}{skill.canvasOnly ? ' · 画布专用' : ''}</option>)}</select><small>{(IMAGE_SKILLS.find(skill => skill.id === active.data.skillId) || IMAGE_SKILLS[0]).slots.map(slot => slot.label + ' ' + slot.min + '–' + slot.max).join('；')}</small></label>}<label>创作要求<textarea rows={10} value={active.data.prompt} onChange={event => setNodes(current => current.map(node => node.id === active.id ? { ...node, data: { ...node.data, prompt: event.target.value } } : node))} /></label><p className="ca-muted">状态：草稿。生成服务尚未接通。</p><button className="ca-danger" onClick={() => { setNodes(current => current.filter(node => node.id !== active.id)); setEdges(current => current.filter(edge => edge.source !== active.id && edge.target !== active.id)); setSelected(''); }}><Trash2 size={14} />删除节点</button></> : <p>在画布中点击节点，编辑它的名称与创作要求。</p>}</aside></div>
  </div>;
}

function parseCanvas(raw: string): CanvasDocument {
  const value = JSON.parse(raw) as CanvasDocument;
  if (value.version !== 1 || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || value.nodes.length > 100 || value.edges.length > 300) throw Error('Invalid canvas');
  const seen = new Set<string>();
  const nodes = value.nodes.map((node, index) => {
    if (!node || typeof node.id !== 'string' || seen.has(node.id) || node.id.length > 100 || !node.data || typeof node.data.label !== 'string' || typeof node.data.prompt !== 'string' || !['text', 'image', 'video'].includes(node.data.kind) || !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)) throw Error('Invalid node');
    seen.add(node.id);
    return { ...createNode(node.data.kind, index), id: node.id, position: { x: node.position.x, y: node.position.y }, data: { kind: node.data.kind, label: node.data.label.slice(0, 120), prompt: node.data.prompt.slice(0, 10000), ...(typeof node.data.skillId === 'string' && IMAGE_SKILLS.some(skill => skill.id === node.data.skillId) ? { skillId: node.data.skillId } : {}) } };
  });
  const edgeIds = new Set<string>();
  const edges = value.edges.map(edge => {
    if (!edge || typeof edge.id !== 'string' || edgeIds.has(edge.id) || !seen.has(edge.source) || !seen.has(edge.target) || edge.source === edge.target) throw Error('Invalid edge');
    edgeIds.add(edge.id);
    return { id: edge.id, source: edge.source, target: edge.target, label: typeof edge.label === 'string' ? edge.label.slice(0, 80) : '参考 / 指令' };
  });
  return { version: 1, nodes, edges };
}
