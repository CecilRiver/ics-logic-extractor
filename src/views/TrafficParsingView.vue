<script setup lang="ts">
import { Network, Upload } from 'lucide-vue-next';
import '@/features/traffic-parsing/traffic-parsing.css';

const FLOW = [
  ['01', '上传抓包'],
  ['02', '协议识别'],
  ['03', '读写还原'],
  ['04', '时序补全'],
] as const;

const PLAN = [
  ['协议识别', '识别工业协议与控制器会话'],
  ['读写关系', '还原操作点位与业务变量映射'],
  ['时序补全', '补充周期触发与事件触发条件'],
] as const;
</script>

<template>
  <section class="mp-view-heading">
    <div>
      <div class="mp-eyebrow">CONTROL PROGRAM / TRAFFIC</div>
      <h1>控制程序流量解析</h1>
      <p>上传控制程序通信流量（PCAP），解析主客体读写关系、调用时序与控制参数，补全由操作规范得到的业务逻辑模型。</p>
    </div>
    <ol class="mp-flow" aria-label="解析流程">
      <li v-for="[index, label] in FLOW" :key="index">
        <b>{{ index }}</b><span>{{ label }}</span>
      </li>
    </ol>
  </section>

  <section class="tp-panel">
    <div class="tp-mark"><Network :size="26" /></div>
    <div class="tp-copy">
      <div class="mp-eyebrow">PCAP / CONTROL PROGRAM</div>
      <h2>流量解析能力待接入</h2>
      <p>
        当前版本先开放操作手册提取。流量解析页已保留独立路由与页面骨架，
        后续接入抓包解析后，将从 PCAP 中提取协议会话、主客体读写关系与调用时序。
      </p>
      <div class="tp-actions">
        <button type="button" class="mp-btn" disabled><Upload :size="14" />上传抓包文件</button>
        <span class="tp-badge">待接入</span>
      </div>
    </div>

    <ul class="tp-plan">
      <li v-for="[title, desc] in PLAN" :key="title">
        <b>{{ title }}</b><span>{{ desc }}</span>
      </li>
    </ul>
  </section>
</template>
