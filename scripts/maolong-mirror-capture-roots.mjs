import fs from 'node:fs';
import path from 'node:path';

export const defaultMaolongMirrorRoots=[
 'F:/总项目文件/Skill存储系统/01_网页开发项目/应用仓库/08_隔离运行/maolong-live-mirror-20260925',
 'F:/总项目文件/Skill存储系统/01_网页开发项目/应用仓库/08_隔离运行/maolong-live-mirror-20260925-full',
 'F:/总项目文件/Skill存储系统/01_网页开发项目/应用仓库/08_隔离运行/maolong-live-mirror-20260925-closure1',
 'F:/总项目文件/Skill存储系统/01_网页开发项目/应用仓库/08_隔离运行/maolong-live-mirror-20260925-closure2',
 'F:/总项目文件/Skill存储系统/01_网页开发项目/应用仓库/08_隔离运行/maolong-live-mirror-20260925-static-closure',
 'F:/总项目文件/Skill存储系统/01_网页开发项目/应用仓库/08_隔离运行/maolong-live-mirror-20260925-closure3',
 'F:/总项目文件/Skill存储系统/01_网页开发项目/应用仓库/08_隔离运行/maolong-live-mirror-20260925-closure4',
 'F:/总项目文件/Skill存储系统/01_网页开发项目/应用仓库/08_隔离运行/maolong-live-mirror-20260925-closure5',
 'F:/总项目文件/Skill存储系统/01_网页开发项目/应用仓库/08_隔离运行/maolong-live-mirror-20260925-conditional-entries/capture',
 'F:/总项目文件/Skill存储系统/01_网页开发项目/应用仓库/08_隔离运行/maolong-live-mirror-20260925-runtime-payload-supplemental/capture',
 'F:/总项目文件/Skill存储系统/01_网页开发项目/应用仓库/08_隔离运行/maolong-live-mirror-20260925-canvas-detail-api-supplemental/capture',
 'F:/总项目文件/Skill存储系统/01_网页开发项目/应用仓库/08_隔离运行/maolong-live-mirror-20260925-canvas-detail-closure/capture',
 'F:/总项目文件/Skill存储系统/01_网页开发项目/应用仓库/08_隔离运行/maolong-live-mirror-20260925-canvas-detail-closure2/capture',
];

export function resolveMaolongMirrorRoots(raw=process.env.MAOLONG_MIRROR_ROOTS_JSON){
 const configured=raw?JSON.parse(raw):defaultMaolongMirrorRoots;
 if(!Array.isArray(configured))throw Error('MAOLONG_MIRROR_ROOTS_JSON must be a JSON array');
 return configured.map(value=>path.resolve(String(value))).filter(value=>fs.existsSync(value));
}

export function maolongCaptureLabel(root){
 return path.basename(root)==='capture'?path.basename(path.dirname(root))+'/capture':path.basename(root);
}
