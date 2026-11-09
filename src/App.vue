<script setup lang="ts">
import { FileText, Network, ShieldCheck } from 'lucide-vue-next';
</script>

<template>
  <div class="mp-app">
    <header class="mp-topbar">
      <RouterLink class="mp-brand" to="/manual">
        <span class="mp-mark"><ShieldCheck :size="19" /></span>
        <span>
          <strong>业务逻辑提取工具</strong>
          <small>OPERATION SPEC &amp; TRAFFIC</small>
        </span>
      </RouterLink>

      <nav class="mp-nav" aria-label="工具导航">
        <RouterLink to="/manual"><FileText :size="15" />操作手册提取</RouterLink>
        <RouterLink to="/traffic"><Network :size="15" />流量解析<em>待接入</em></RouterLink>
      </nav>
    </header>

    <main class="mp-main">
      <RouterView />
    </main>
  </div>
</template>
