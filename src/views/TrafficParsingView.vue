<script setup lang="ts">
import TrafficParsing from '@/features/traffic-parsing/TrafficParsing.vue';

const FLOW = [
  ['01', '配置网络'],
  ['02', '收集流量'],
  ['03', '离线解析'],
  ['04', '变量属性'],
] as const;
</script>

<template>
  <section class="mp-view-heading">
    <div>
      <div class="mp-eyebrow">CONTROL PROGRAM / TRAFFIC</div>
      <h1>控制程序解析</h1>
      <p>
        先采集被测 PLC 的上载、运行与 IO 流量并保存 PCAPNG，再离线解析控制程序，
        提取关键变量与值域范围。两步分开执行，采集结果可回看、下载。
      </p>
    </div>
    <ol class="mp-flow" aria-label="解析流程">
      <li v-for="[index, label] in FLOW" :key="index">
        <b>{{ index }}</b><span>{{ label }}</span>
      </li>
    </ol>
  </section>

  <TrafficParsing />
</template>
