import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const source = await fs.readFile('prompts/storyboard-high-energy-assets-order-B-v2.md', 'utf8');
assert.equal(sha(source), '105d7cba62452c1ca493d858de9df8a0a498a1ac1be578913b65ef73ceb0dcda');
const eventContract = `# 纯文本任务边界
本次只编译文字提示词，没有可用工具。不要发工具或函数调用，不读写文件、不联网、不创建任务；全部结果直接作为最终文本返回完整Markdown。不能用工具调用、任务ID或空正文代替结果。

# 原文事件保全：优先于美化与压缩
先把每个原文分句中的核心事件静默登记为“执行者、原文动作、受作用对象、起始状态、完成状态、能在画面看见的证据、所属段号、发生顺序”，再分配镜头。事件表是不可删的语义底稿，不能用自编的微故事替换。动作与它造成的状态是两项不同信息：原文明说操作时，镜头必须从操作前拍到接触/操作及结果，不能直接从完成状态起播。例如“剪断丝带”不能只展示已断的丝带，“走到窗边”不能只让角色站在房间里望窗。
逐个核对原文的先、再、等、才、随后等时序：引导动作必须可见，不能让对象自己完成而省去执行者；等待可以用连续观察和对象完成后的状态变化表达；移动到另一地点必须出现实际跨越或在新地点继续行走的证据，不能只停在门前、光线或准备姿态。认知/决定用当段真实可见的准备或选择承接，不能提前完成下一段事件。
各事件必须按顺序出现在生图的静态峰值与视频的动作链中，同镜头可覆盖相邻的短动作，但一镜只有一个主动作链。镜头数、包装次数、提示词密度都不能成为删事件的理由；无法在目标时长安全演完时，完整保留原文并说明容量问题，禁止默默省掉核心动词。最后逐条把事件表与两份Prompt对账，少一个动作或更换受作用对象就重写对应镜头。
可移动道具的来源、持有及转手状态独立于角色身份：双手需要操作新道具时，先明确原手持物放回、暂放、套腕或交给另一个合理主体，之后再拿回；新道具在初次使用前有可见所在位置或取出路径。没有来源不让它突然出现在手中。门的开向与施力必须一致：人物在内侧操作内开门时向内拉，外开门时向外推；滑门沿轨道移动；原文没有门则不加门动作。
需要人物或宠物三视图时，仅用一行1×3同一中性站姿：正面、严格90度侧面、背面。参考板不采用2×2加底部全宽，不增加空备位或故事格；更多角度只在用户明确需要时另加。场景保持独立建立图，道具保持独立多角度板。
`;
const revised = eventContract + '\n' + source.replace('候选 B v2', '候选 B v3').replaceAll('相应上限乘以2.5', '相应上限乘以4');
const destination = 'prompts/storyboard-high-energy-assets-order-B-v3.md';
try { await fs.writeFile(destination, revised, { flag: 'wx' }); }
catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await fs.readFile(destination, 'utf8'), revised); }
console.log(JSON.stringify({ path: destination, parentSha256: sha(source), sha256: sha(revised.trim()), fileSha256: sha(revised), characters: revised.trim().length, reason: 'Real cross-segment semantic coverage failures and English execution-text density', stablePromptWrites: 0, providerCalls: 0 }, null, 2));
