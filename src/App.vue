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
      <!-- 缓存路由页面：切到流量解析再回来时，手册上传的分段与抽取结果不会丢失。 -->
      <RouterView v-slot="{ Component }">
        <KeepAlive>
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </main>
  </div>
</template>
