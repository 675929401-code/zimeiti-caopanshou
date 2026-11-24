import type {Metadata} from 'next';
import {CommerceMemberPage} from '@/features/commerce-studio/member-page';
import {MemberAccount} from '../../../commerce/components/commerce-agent/member-account';

export const metadata:Metadata={title:'我的账户 · 带货 Agent',description:'账号资料、现金余额与收支记录，与主站会员钱包实时同步。'};
export default function CommerceAccountPage(){return <CommerceMemberPage><MemberAccount/></CommerceMemberPage>;}
