<script setup lang="ts">
import ManualExtraction from '@/features/manual-extraction/ManualExtraction.vue';

const FLOW = [
  ['01', '上传解析'],
  ['02', '按页分段'],
  ['03', '三段抽取'],
  ['04', '合并导出'],
] as const;
</script>

<template>
  <section class="mp-view-heading">
    <div>
      <div class="mp-eyebrow">OPERATION SPECIFICATION / MANUAL</div>
      <h1>操作手册提取</h1>
      <p>上传操作手册，按页分段后依次抽取设备、业务拓扑与控制逻辑，结果可人工复核并导出。</p>
    </div>
    <ol class="mp-flow" aria-label="提取流程">
      <li v-for="[index, label] in FLOW" :key="index">
        <b>{{ index }}</b><span>{{ label }}</span>
      </li>
    </ol>
  </section>

  <ManualExtraction />
</template>

<style scoped>
.mp-view-heading h1 {
  margin: 3px 0 5px;
  font-size: clamp(24px, 3vw, 30px);
  font-weight: 600;
  letter-spacing: -.015em;
  line-height: 1.25;
}

.mp-view-heading p {
  max-width: 760px;
  margin: 0;
  color: var(--mp-muted);
  font-size: 13px;
}
</style>
