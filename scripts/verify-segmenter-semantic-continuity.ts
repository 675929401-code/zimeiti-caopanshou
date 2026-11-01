import assert from "node:assert/strict";
import {
  countChars,
  normalizeForIntegrity,
  segmentTextRule,
  splitParagraphClauses,
} from "../src/lib/segmenter-core";

const source = "狗是胖点好还是瘦点好？答案永远都是瘦点好。人类不有一句话吗？“千金难买老来瘦”。狗也一样。现在出去遛狗，主人最怕听到的一句话就是：“你家狗怎么这么瘦？”就好像是你舍不得给它吃似的，虐待它一样。现在审美都不知道怎么回事，都喜欢胖的。猫狗胖的可爱，养的太胖那不叫养的好，你那是在养猪呢，你要按斤给它卖钱呢。你要从俯视看，什么样的身材是最好的？俯视看它是凹凸有致的，顺着它的侧边摸下去是能摸到肋骨的。这样的狗它不容易生病，体格子还当当的。你就看着像一个球似的，一点腰线都没有，后背溜平，看着可爱，但是你家狗就老遭罪了，走两步就喘的不行。你等再过两年老了，什么糖尿病、心脏病、关节炎都找上门了。狗这个物种它本身就馋，有的狗甚至都不知道饥饱，你给它多少它吃多少，尤其是绝育之后，七情六欲就剩食欲了，吃的像个大气球似的。能把狗狗的体重控制特别好的主人是非常厉害的。你可以拍一下你家狗狗的俯视图，我给你看看你家的狗是胖还是瘦。";

const quoteClauses = splitParagraphClauses("主人问“你家狗怎么这么瘦？”就走了。");
assert.equal(quoteClauses[0], "主人问“你家狗怎么这么瘦？”");
assert.equal(quoteClauses[1], "就走了。");

const result = segmentTextRule(source, 10);
const reconstructed = result.segments.join("");
console.log(JSON.stringify({ counts: result.counts, segments: result.segments, overlapPrefixes: result.overlapPrefixes }, null, 2));
assert.equal(normalizeForIntegrity(reconstructed), normalizeForIntegrity(source));
assert.equal(result.segments.length, 7);
assert.ok(result.segments.every(segment => !/^[”’」』）》】]/u.test(segment)), "右引号不得落到下一段开头");
assert.ok(result.counts.every(count => count <= 60), `字数不得超过60，实际：${result.counts.join(",")}`);
assert.equal(result.counts.reduce((sum, count) => sum + count, 0), countChars(source));
assert.ok(!result.overlapPrefixes?.some(Boolean));

const unpunctuated = "长".repeat(400);
const durationResults = [8, 10, 12, 15, 16, 20, 25].map(duration => {
  const value = segmentTextRule(unpunctuated, duration);
  assert.ok(value.segments.length > 1, `${duration}秒无标点长文必须实际切分`);
  assert.equal(
    normalizeForIntegrity(value.segments.join("")),
    unpunctuated,
    `${duration}秒无标点长文必须保持原文完整`,
  );
  const mode = ({
    8: [40, 48], 10: [50, 60], 12: [60, 72], 15: [75, 90],
    16: [80, 96], 20: [100, 120], 25: [125, 150],
  } as Record<number, [number, number]>)[duration];
  assert.ok(value.counts.every(count => count >= mode[0] && count <= mode[1]), `${duration}秒无标点分段必须落在目标范围`);
  return { duration, segmentCount: value.segments.length, counts: value.counts };
});
assert.ok(new Set(durationResults.map(item => item.segmentCount)).size >= 5, "七个时长预设必须对无标点长文产生可区分结果");

console.log(JSON.stringify({
  passed: true,
  counts: result.counts,
  segments: result.segments,
  overlapPrefixes: result.overlapPrefixes,
  sourceChars: countChars(source),
  reconstructed: normalizeForIntegrity(reconstructed) === normalizeForIntegrity(source),
  unpunctuatedDurationResults: durationResults,
}, null, 2));
