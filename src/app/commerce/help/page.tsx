import type {Metadata} from 'next';
import {HelpCenter} from '../../../commerce/components/commerce-agent/help-center';

export const metadata:Metadata={title:'使用教程 · 带货 Agent',description:'从四种创作入口开始，学习素材、脚本、图片、视频、画布、保存与结果恢复。'};
export default function HelpPage(){return <HelpCenter/>;}
