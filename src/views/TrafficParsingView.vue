<script setup lang="ts">
import TrafficParsing from '@/features/traffic-parsing/TrafficParsing.vue';

const FLOW = [
  ['01', '配置网络'],
  ['02', '提取程序'],
  ['03', '逆向源码'],
  ['04', '变量属性'],
] as const;
</script>

<template>
  <section class="mp-view-heading">
    <div>
      <div class="mp-eyebrow">CONTROL PROGRAM / TRAFFIC</div>
      <h1>控制程序解析</h1>
      <p>
        配置被测 PLC 网络参数，自动完成控制程序提取，页面展示提取到的控制程序及解析成功标识，
        并进一步提取关键变量与值域范围。
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
