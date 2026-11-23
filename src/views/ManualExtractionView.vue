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
      <h1>操作规范解析</h1>
      <p>上传操作规范（操作手册）文档，按页分段后依次抽取设备、业务拓扑与控制逻辑，并可单独执行操作规范属性提取，结果可人工复核并导出。</p>
    </div>
    <ol class="mp-flow" aria-label="提取流程">
      <li v-for="[index, label] in FLOW" :key="index">
        <b>{{ index }}</b><span>{{ label }}</span>
      </li>
    </ol>
  </section>

  <ManualExtraction />
</template>
