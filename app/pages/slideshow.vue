<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core';

const ROTATE_MS = 5000;

const ids = ref<string[]>([]);
const currentId = ref<string | undefined>();

const currentSrc = computed(() =>
  currentId.value
    ? `/api/captures/${encodeURIComponent(currentId.value)}/wm`
    : undefined,
);

async function refreshIds() {
  const { ids: list } = await $fetch<{ ids: string[] }>('/api/captures');
  ids.value = list;
}

function pickRandom() {
  const list = ids.value;
  if (list.length === 0) {
    currentId.value = undefined;
    return;
  }
  if (list.length === 1) {
    currentId.value = list[0];
    return;
  }
  let next = list[Math.floor(Math.random() * list.length)]!;
  while (next === currentId.value) {
    next = list[Math.floor(Math.random() * list.length)]!;
  }
  currentId.value = next;
}

onMounted(async () => {
  await refreshIds();
  pickRandom();
});

useIntervalFn(
  async () => {
    await refreshIds();
    pickRandom();
  },
  ROTATE_MS,
);
</script>

<template>
  <div class="relative w-full h-svh bg-black">
    <img v-if="currentSrc" :key="currentSrc" :src="currentSrc" class="absolute inset-0 w-full h-svh object-cover"
      alt="" />
    <div v-else class="absolute inset-0 flex items-center justify-center text-white/60 text-xl">
      No photos yet
    </div>
    <div class="absolute left-0 bottom-0 flex flex-wrap items-end gap-4 p-4 max-w-full pointer-events-none">
      <img src="/qr-code.svg" class="w-84 shrink-0" alt="" />
      <p
        class="text-white text-lg sm:text-5xl font-medium leading-snug max-w-md drop-shadow-[0_2px_6px_rgba(0,0,0,0.85)]">
        Get your images,<br> scan QR Code or join<br> @BASSM8S_Photobooth
      </p>
    </div>
  </div>
</template>
