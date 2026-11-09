<script setup lang="ts">
import type { ManualDevice, Sourced } from '@/domain/manual';

defineProps<{ rows: Sourced<ManualDevice>[] }>();

function locationTone(location: string): string {
  if (location === '行为主体') return 'subject';
  if (location === '行为客体') return 'object';
  return 'both';
}
</script>

<template>
  <div class="mp-table-wrap">
    <table class="mp-table">
      <thead>
        <tr>
          <th>设备名称</th><th>设备定位</th><th>设备类型</th><th>原文依据</th><th>来源分段</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="({ row, sources }, index) in rows" :key="`${row.name}-${index}`">
          <td><b>{{ row.name }}</b></td>
          <td>
            <span v-if="row.location" class="mp-tag" :class="locationTone(row.location)">{{ row.location }}</span>
            <span v-else class="mp-muted">—</span>
          </td>
          <td>
            <span v-if="row.type" class="mp-tag type">{{ row.type }}</span>
            <span v-else class="mp-muted">—</span>
          </td>
          <td class="mp-evidence">{{ row.evidence || '—' }}</td>
          <td class="mono">{{ sources.join(', ') }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="5" class="mp-empty">暂无设备抽取结果</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
