<script setup lang="ts">
import { formatValueRangeCell, type ManualLogicRow, type Sourced } from '@/domain/manual';

defineProps<{ rows: Sourced<ManualLogicRow>[] }>();
</script>

<template>
  <div class="mp-table-wrap">
    <table class="mp-table widest">
      <thead>
        <tr>
          <th>行为主体</th><th>主体类型</th><th>行为客体</th><th>客体类型</th><th>行为类型</th><th>行为内容</th>
          <th>目标类型</th><th>目标参数</th><th>目标参数值</th><th>操作对象</th><th>操作值域</th>
          <th>触发原因</th><th>触发类型</th><th>触发结果</th><th>原文依据</th><th>来源</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="({ row, sources }, index) in rows" :key="`${row.subject}-${row.content}-${index}`">
          <td><b>{{ row.subject || '—' }}</b></td>
          <td>{{ row.subjectType || '—' }}</td>
          <td>{{ row.object || '—' }}</td>
          <td>{{ row.objectType || '—' }}</td>
          <td>
            <span v-if="row.actionType" class="mp-tag" :class="row.actionType === '写' ? 'write' : 'read'">{{ row.actionType }}</span>
            <template v-else>—</template>
          </td>
          <td>{{ row.content || '—' }}</td>
          <td>{{ row.targetType || '—' }}</td>
          <td>{{ row.targetParam || '—' }}</td>
          <td>{{ row.targetValue || '—' }}</td>
          <td>{{ row.operationObject || '—' }}</td>
          <td>{{ formatValueRangeCell(row) || '—' }}</td>
          <td>{{ row.triggerCause || '—' }}</td>
          <td>
            <span v-if="row.triggerType" class="mp-tag" :class="row.triggerType === '周期式' ? 'cycle' : 'event'">{{ row.triggerType }}</span>
            <template v-else>—</template>
          </td>
          <td>{{ row.triggerResult || '—' }}</td>
          <td class="mp-evidence">{{ row.evidence || '—' }}</td>
          <td class="mono">{{ sources.join(', ') }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="16" class="mp-empty">暂无控制逻辑抽取结果</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
