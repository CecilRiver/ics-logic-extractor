import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import ManualExtractionView from '../views/ManualExtractionView.vue';
import TrafficParsingView from '../views/TrafficParsingView.vue';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/manual' },
  {
    path: '/manual',
    name: 'manual',
    component: ManualExtractionView,
    meta: { title: '操作手册提取' },
  },
  {
    path: '/traffic',
    name: 'traffic',
    component: TrafficParsingView,
    meta: { title: '流量解析' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/manual' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '';
  document.title = title ? `${title} · 业务逻辑提取工具` : '业务逻辑提取工具';
});
