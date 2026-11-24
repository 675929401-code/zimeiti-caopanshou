'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const exampleLabels = [
  '首图 / 主视觉', '卖点图 / 功效', '细节图 / 材质', '成分图 / 配料',
  '场景图 / 使用', '结构图 / 功能', '卖点图 / 功效', '对比图 / 痛点',
  '场景图 / 使用', '细节图 / 材质', '包装图 / 到手', '收尾图 / CTA',
];

export function DetailExamples() {
  const [index, setIndex] = useState(0);
  function move(step: number) {
    setIndex(current => (current + step + exampleLabels.length) % exampleLabels.length);
  }
  return <section className="cs-detail-carousel" aria-label="商详参考示例">
    <header>
      <h2>参考示例</h2>
      <p>按 <strong>图片类型</strong> 串联完整商详图结构，帮助你快速理解生成方向</p>
    </header>
    <div className="cs-detail-carousel-stage">
      <div className="cs-detail-carousel-picture">
        <img src={'/commerce/detail-set/ecommerce-detail-example-' + String(index + 1).padStart(2, '0') + '.jpg'}
          alt={exampleLabels[index] + '参考示例 ' + (index + 1)} />
        <button type="button" aria-label="上一个示例" onClick={() => move(-1)}><ChevronLeft size={18} /></button>
        <button type="button" aria-label="下一个示例" onClick={() => move(1)}><ChevronRight size={18} /></button>
      </div>
      <nav aria-label="示例翻页">
        {exampleLabels.map((label, i) => <button key={i} type="button" title={label} aria-label={'查看示例 ' + (i + 1)}
          aria-pressed={i === index} onClick={() => setIndex(i)} />)}
      </nav>
    </div>
  </section>;
}
